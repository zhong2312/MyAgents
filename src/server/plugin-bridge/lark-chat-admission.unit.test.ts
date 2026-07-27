import { beforeAll, describe, expect, it } from 'vitest';

import {
  installLarkAdmissionRuntimeGlobals,
  markCurrentLarkInboundAccepted,
} from './lark-admission';
import { patchLarkChatQueueSource } from './plugin-compat-patches';

const CHAT_QUEUE_FIXTURE = `"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Process-level chat task queue.
 *
 * Although located in channel/, this module is intentionally shared
 * across channel, messaging, tools, and card layers as a process-level
 * singleton. Consumers: monitor.ts, dispatch.ts, oauth.ts, auto-auth.ts.
 *
 * Ensures tasks targeting the same account+chat are executed serially.
 * Used by both websocket inbound messages and synthetic message paths.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.threadScopedKey = threadScopedKey;
exports.buildQueueKey = buildQueueKey;
exports.registerActiveDispatcher = registerActiveDispatcher;
exports.unregisterActiveDispatcher = unregisterActiveDispatcher;
exports.getActiveDispatcher = getActiveDispatcher;
exports.hasActiveTask = hasActiveTask;
exports.enqueueFeishuChatTask = enqueueFeishuChatTask;
exports._resetChatQueueState = _resetChatQueueState;
const chatQueues = new Map();
const activeDispatchers = new Map();
/**
 * Append \`:thread:{threadId}\` suffix when threadId is present.
 * Consistent with the SDK's \`:thread:\` separator convention.
 */
function threadScopedKey(base, threadId) {
    return threadId ? \`${'${base}'}:thread:${'${threadId}'}\` : base;
}
function buildQueueKey(accountId, chatId, threadId) {
    return threadScopedKey(\`${'${accountId}'}:${'${chatId}'}\`, threadId);
}
function registerActiveDispatcher(key, entry) {
    activeDispatchers.set(key, entry);
}
function unregisterActiveDispatcher(key) {
    activeDispatchers.delete(key);
}
function getActiveDispatcher(key) {
    return activeDispatchers.get(key);
}
/** Check whether the queue has an active task for the given key. */
function hasActiveTask(key) {
    return chatQueues.has(key);
}
function enqueueFeishuChatTask(params) {
    const { accountId, chatId, threadId, task } = params;
    const key = buildQueueKey(accountId, chatId, threadId);
    const prev = chatQueues.get(key) ?? Promise.resolve();
    const status = chatQueues.has(key) ? 'queued' : 'immediate';
    const taskPromise = prev.then(task, task);
    chatQueues.set(key, taskPromise);
    const cleanup = () => {
        if (chatQueues.get(key) === taskPromise) {
            chatQueues.delete(key);
        }
    };
    taskPromise.then(cleanup, cleanup);
    return { status, promise: taskPromise };
}
/** @internal Test-only: reset all queue and dispatcher state. */
function _resetChatQueueState() {
    chatQueues.clear();
    activeDispatchers.clear();
}
`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type QueueModule = {
  buildQueueKey: (accountId: string, chatId: string, threadId?: string) => string;
  registerActiveDispatcher: (key: string, entry: object) => void;
  unregisterActiveDispatcher: (key: string) => void;
  getActiveDispatcher: (key: string) => object | undefined;
  hasActiveTask: (key: string) => boolean;
  enqueueFeishuChatTask: (params: {
    accountId: string;
    chatId: string;
    task: () => Promise<void>;
  }) => { status: 'immediate' | 'queued'; promise: Promise<void> };
};

function loadPatchedQueue(): QueueModule {
  const patched = patchLarkChatQueueSource(CHAT_QUEUE_FIXTURE);
  if (!patched) throw new Error('fixture no longer matches the official Lark queue contract');
  const module = { exports: {} as QueueModule };
  Function('exports', 'module', patched)(module.exports, module);
  return module.exports;
}

describe('official Lark chat admission compatibility', () => {
  beforeAll(() => {
    installLarkAdmissionRuntimeGlobals();
  });

  it('releases same-chat FIFO at Rust admission while keeping each dispatcher alive to completion', async () => {
    const queue = loadPatchedQueue();
    const key = queue.buildQueueKey('default', 'chat-1');
    const allowFirstAdmission = deferred();
    const completeFirst = deferred();
    const completeSecond = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const firstDispatcher = { id: 'first' };
    const secondDispatcher = { id: 'second' };

    const first = queue.enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      task: async () => {
        queue.registerActiveDispatcher(key, firstDispatcher);
        firstStarted.resolve();
        try {
          await allowFirstAdmission.promise;
          markCurrentLarkInboundAccepted();
          await completeFirst.promise;
        } finally {
          queue.unregisterActiveDispatcher(key);
        }
      },
    });
    await firstStarted.promise;

    const second = queue.enqueueFeishuChatTask({
      accountId: 'default',
      chatId: 'chat-1',
      task: async () => {
        queue.registerActiveDispatcher(key, secondDispatcher);
        secondStarted.resolve();
        try {
          markCurrentLarkInboundAccepted();
          await completeSecond.promise;
        } finally {
          queue.unregisterActiveDispatcher(key);
        }
      },
    });

    expect(first.status).toBe('immediate');
    expect(second.status).toBe('queued');
    expect(queue.hasActiveTask(key)).toBe(true);
    expect(queue.getActiveDispatcher(key)).toBe(firstDispatcher);

    let secondDidStart = false;
    void secondStarted.promise.then(() => { secondDidStart = true; });
    await Promise.resolve();
    expect(secondDidStart).toBe(false);

    allowFirstAdmission.resolve();
    await secondStarted.promise;
    expect(queue.getActiveDispatcher(key)).toBe(secondDispatcher);

    completeSecond.resolve();
    await second.promise;
    expect(queue.getActiveDispatcher(key)).toBe(firstDispatcher);
    expect(queue.hasActiveTask(key)).toBe(true);

    completeFirst.resolve();
    await first.promise;
    expect(queue.getActiveDispatcher(key)).toBeUndefined();
    expect(queue.hasActiveTask(key)).toBe(false);
  });

  it('leaves an unknown upstream queue shape untouched', () => {
    expect(patchLarkChatQueueSource('function enqueueFeishuChatTask() {}')).toBeNull();
  });

  it('fails closed when the upstream enqueue lifecycle is only a near match', () => {
    const changedUpstream = CHAT_QUEUE_FIXTURE.replace(
      'const taskPromise = prev.then(task, task);',
      'const taskPromise = prev.then(() => task(), () => task());',
    );
    expect(patchLarkChatQueueSource(changedUpstream)).toBeNull();
  });

  it('fails closed when upstream adds a consumer outside the replaced blocks', () => {
    const changedUpstream = CHAT_QUEUE_FIXTURE.replace(
      '/** Check whether the queue has an active task for the given key. */',
      `function waitForChatTask(key) {
    return chatQueues.get(key)?.then(() => undefined);
}
/** Check whether the queue has an active task for the given key. */`,
    );
    expect(patchLarkChatQueueSource(changedUpstream)).toBeNull();
  });
});
