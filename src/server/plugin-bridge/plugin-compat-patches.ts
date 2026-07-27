const LARK_REGISTER_DISPATCHER = `function registerActiveDispatcher(key, entry) {
    activeDispatchers.set(key, entry);
}`;

const LARK_UNREGISTER_DISPATCHER = `function unregisterActiveDispatcher(key) {
    activeDispatchers.delete(key);
}`;

const LARK_GET_DISPATCHER = `function getActiveDispatcher(key) {
    return activeDispatchers.get(key);
}`;

const LARK_REGISTER_DISPATCHER_PATCH = `function registerActiveDispatcher(key, entry) {
    const token = globalThis.__myagentsCurrentLarkAdmissionToken?.();
    const existing = activeDispatchers.get(key);
    const entries = existing instanceof Map ? existing : new Map();
    entries.set(token ?? entry, entry);
    activeDispatchers.set(key, entries);
}`;

const LARK_UNREGISTER_DISPATCHER_PATCH = `function unregisterActiveDispatcher(key) {
    const entries = activeDispatchers.get(key);
    if (!(entries instanceof Map)) {
        activeDispatchers.delete(key);
        return;
    }
    const token = globalThis.__myagentsCurrentLarkAdmissionToken?.();
    if (token === undefined) {
        activeDispatchers.delete(key);
        return;
    }
    entries.delete(token);
    if (entries.size === 0) {
        activeDispatchers.delete(key);
    }
}`;

const LARK_GET_DISPATCHER_PATCH = `function getActiveDispatcher(key) {
    const entries = activeDispatchers.get(key);
    if (!(entries instanceof Map)) {
        return entries;
    }
    let latest;
    for (const entry of entries.values()) {
        latest = entry;
    }
    return latest;
}`;

const LARK_ENQUEUE = `function enqueueFeishuChatTask(params) {
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
}`;

const LARK_ENQUEUE_PATCH = `function enqueueFeishuChatTask(params) {
    const { accountId, chatId, threadId, task } = params;
    const key = buildQueueKey(accountId, chatId, threadId);
    const previous = chatQueues.get(key);
    const previousAdmission = previous?.admission ?? Promise.resolve();
    const activeTasks = previous?.activeTasks ?? new Set();
    const status = chatQueues.has(key) ? 'queued' : 'immediate';
    const launch = () => {
        const runner = globalThis.__myagentsRunLarkAdmissionScopedTask;
        if (typeof runner === 'function') {
            return runner(task);
        }
        const completion = Promise.resolve().then(task);
        return {
            admission: completion.then(() => undefined, () => undefined),
            completion,
        };
    };
    const launched = previousAdmission.then(launch, launch);
    const admission = launched.then((execution) => execution.admission);
    const taskPromise = launched.then((execution) => execution.completion);
    const entry = { admission, activeTasks };
    activeTasks.add(taskPromise);
    chatQueues.set(key, entry);
    const cleanup = () => {
        activeTasks.delete(taskPromise);
        if (activeTasks.size === 0 && chatQueues.get(key)?.activeTasks === activeTasks) {
            chatQueues.delete(key);
        }
    };
    taskPromise.then(cleanup, cleanup);
    return { status, promise: taskPromise };
}`;

/**
 * Narrow compatibility transform for the official @larksuite/openclaw-lark
 * process-level queue. It keeps task completion request-scoped while moving
 * only same-chat scheduling to the Bridge→Rust admission boundary.
 *
 * Returning null is deliberate fail-closed behavior for an unknown upstream
 * source shape: load the plugin unchanged instead of guessing at its private
 * lifecycle.
 */
export function patchLarkChatQueueSource(source: string): string | null {
  const fingerprint = createHash('sha256').update(source).digest('hex');
  if (fingerprint !== KNOWN_LARK_CHAT_QUEUE_SHA256) return null;

  const knownBlocks = [
    LARK_REGISTER_DISPATCHER,
    LARK_UNREGISTER_DISPATCHER,
    LARK_GET_DISPATCHER,
    LARK_ENQUEUE,
  ];
  if (knownBlocks.some((block) => source.split(block).length !== 2)) {
    return null;
  }

  return source
    .replace(LARK_REGISTER_DISPATCHER, LARK_REGISTER_DISPATCHER_PATCH)
    .replace(LARK_UNREGISTER_DISPATCHER, LARK_UNREGISTER_DISPATCHER_PATCH)
    .replace(LARK_GET_DISPATCHER, LARK_GET_DISPATCHER_PATCH)
    .replace(LARK_ENQUEUE, LARK_ENQUEUE_PATCH);
}
import { createHash } from 'node:crypto';

const KNOWN_LARK_CHAT_QUEUE_SHA256 = '439851fff11b078730e9bab9b0405076e5c73cb29bb37f2d20b0c147ca7c791a';
