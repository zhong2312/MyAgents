// === AUTO-AUGMENT: drift-stubs from upstream openclaw — do not edit this block ===
// Stubs for upstream openclaw exports the handwritten file below does not
// implement. Regenerate via: npm run generate:sdk-shims
export * from "./reply-runtime.auto.js";
// === END AUTO-AUGMENT ===

/** Shim for openclaw/plugin-sdk/reply-runtime */

// The plugin owns its renderer, but the shim owns the dispatcher lifecycle
// primitive that invokes the plugin's async onIdle callback. Keep observers
// keyed by dispatcher so Bridge diagnostics can measure that real boundary
// without exposing or reimplementing any platform renderer state.
const replyDispatcherIdleObservers = new WeakMap();

function observeReplyDispatcherIdle(dispatcher, observer) {
  replyDispatcherIdleObservers.set(dispatcher, observer);
}

function observeIdleCompletion(dispatcher, idleResult) {
  const observer = replyDispatcherIdleObservers.get(dispatcher);
  if (!observer) return;
  replyDispatcherIdleObservers.delete(dispatcher);
  Promise.resolve(idleResult).then(
    () => observer({ outcome: 'completed' }),
    error => observer({ outcome: 'failed', error }),
  ).catch(() => {});
}

// --- chunk helpers ---

function chunkText(text, limit) {
  if (!text) return [];
  const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : 4000;
  if (text.length <= effectiveLimit) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += effectiveLimit) {
    chunks.push(text.slice(i, i + effectiveLimit));
  }
  return chunks;
}

function chunkTextWithMode(text, limit, _mode) {
  return chunkText(text, limit);
}

function chunkMarkdownText(text, limit) {
  return chunkText(text, limit);
}

function chunkMarkdownTextWithMode(text, limit, _mode) {
  return chunkText(text, limit);
}

function resolveChunkMode(_cfg, _provider, _accountId) {
  return 'length';
}

function resolveTextChunkLimit(_cfg, _provider, _accountId, _opts) {
  return 4000;
}

// --- dispatch helpers ---

async function dispatchInboundMessage(_params) {
  return { status: 'skipped' };
}

async function dispatchInboundMessageWithBufferedDispatcher(_params) {
  return { status: 'skipped' };
}

async function dispatchInboundMessageWithDispatcher(_params) {
  return { status: 'skipped' };
}

// --- group activation ---

function normalizeGroupActivation(raw) {
  const value = raw?.trim().toLowerCase();
  if (value === 'mention') return 'mention';
  if (value === 'always') return 'always';
  return undefined;
}

function parseActivationCommand(raw) {
  if (!raw) return { hasCommand: false };
  const trimmed = raw.trim();
  if (!trimmed) return { hasCommand: false };
  const match = trimmed.match(/^\/activation(?:\s+([a-zA-Z]+))?\s*$/i);
  if (!match) return { hasCommand: false };
  const mode = normalizeGroupActivation(match[1]);
  return { hasCommand: true, mode };
}

// --- heartbeat ---

const HEARTBEAT_PROMPT =
  'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.';
const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

function resolveHeartbeatPrompt(_params) {
  return HEARTBEAT_PROMPT;
}

function stripHeartbeatToken(text) {
  if (!text) return '';
  return text.replace(/HEARTBEAT_OK\s*$/i, '').trim();
}

// --- heartbeat reply payload ---

function resolveHeartbeatReplyPayload(_params) {
  return undefined;
}

// --- reply ---

function getReplyFromConfig(_cfg, _params) {
  return undefined;
}

// --- tokens ---

const HEARTBEAT_TOKEN = 'HEARTBEAT_OK';
const SILENT_REPLY_TOKEN = 'NO_REPLY';

function isSilentReplyText(text, token) {
  if (!text) return false;
  const t = token ?? SILENT_REPLY_TOKEN;
  return new RegExp(`^\\s*${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(text);
}

// --- abort ---

function isAbortRequestText(_text) {
  return false;
}

// --- btw command ---

function isBtwRequestText(_text) {
  return false;
}

// --- inbound dedupe ---

function resetInboundDedupe() {}

// --- inbound context ---

function finalizeInboundContext(ctx) {
  return ctx ?? {};
}

// --- provider dispatcher ---

async function dispatchReplyWithBufferedBlockDispatcher(_params) {}
async function dispatchReplyWithDispatcher(_params) {}

// --- reply dispatcher ---
// Adapted from openclaw/src/auto-reply/reply/reply-dispatcher.ts and
// openclaw/src/auto-reply/dispatch-dispatcher.ts at
// 7c4ab782cb83d7fbab567443feeb7ed179a4e8c3 (MIT).
// Keep this channel-agnostic: platform rendering and pacing belong to the
// loaded plugin, never to the Plugin Bridge.

function emptyReplyCounts() {
  return { tool: 0, block: 0, final: 0 };
}

function hasReplyPayloadContent(payload, text) {
  return Boolean(
    text?.trim()
    || payload?.mediaUrl
    || (Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length > 0)
    || payload?.presentation
    || payload?.interactive,
  );
}

function normalizeReplyPayload(payload, options, kind) {
  if (!payload || typeof payload !== 'object') {
    options.onSkip?.(payload ?? {}, { kind, reason: 'empty' });
    return null;
  }

  let text = typeof payload.text === 'string' ? payload.text : undefined;
  if (!hasReplyPayloadContent(payload, text)) {
    options.onSkip?.(payload, { kind, reason: 'empty' });
    return null;
  }
  if (text && isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
    if (!hasReplyPayloadContent(payload, '')) {
      options.onSkip?.(payload, { kind, reason: 'silent' });
      return null;
    }
    text = '';
  }
  if (text?.includes(HEARTBEAT_TOKEN)) {
    const stripped = stripHeartbeatToken(text);
    if (stripped !== text) options.onHeartbeatStrip?.();
    text = stripped;
    if (!hasReplyPayloadContent(payload, text)) {
      options.onSkip?.(payload, { kind, reason: 'heartbeat' });
      return null;
    }
  }

  let normalized = { ...payload, text };
  if (typeof options.transformReplyPayload === 'function') {
    const transformed = options.transformReplyPayload(normalized);
    if (transformed === null) return null;
    if (transformed && typeof transformed === 'object') normalized = { ...normalized, ...transformed };
  }

  const context = options.responsePrefixContextProvider?.() ?? options.responsePrefixContext;
  const rawPrefix = options.responsePrefix;
  const prefix = typeof rawPrefix === 'function' ? rawPrefix(context) : rawPrefix;
  if (typeof prefix === 'string' && prefix && normalized.text && !normalized.text.startsWith(prefix)) {
    normalized = { ...normalized, text: `${prefix} ${normalized.text}` };
  }
  return normalized;
}

function resolveHumanDelayMs(config) {
  const enabled = config?.mode ? config.mode !== 'off' : config?.enabled === true;
  if (!enabled) return 0;
  const min = Math.max(0, Number(config?.minMs) || 800);
  const max = Math.max(min, Number(config?.maxMs) || 2500);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createReplyDispatcher(options = {}) {
  let beforeDeliver = options.beforeDeliver;
  let sendChain = Promise.resolve();
  let pending = 1; // reservation: prevents idle before the producer seals the dispatcher
  let completeCalled = false;
  let sentFirstBlock = false;
  let idleCalled = false;
  const queuedCounts = emptyReplyCounts();
  const failedCounts = emptyReplyCounts();
  const cancelledCounts = emptyReplyCounts();

  const notifyIdle = () => {
    if (pending !== 0 || idleCalled) return;
    idleCalled = true;
    void options.onIdle?.();
  };

  const enqueue = (kind, payload) => {
    const normalized = normalizeReplyPayload(payload, options, kind);
    if (!normalized) return false;
    queuedCounts[kind] += 1;
    pending += 1;
    const shouldDelay = kind === 'block' && sentFirstBlock;
    if (kind === 'block') sentFirstBlock = true;

    sendChain = sendChain
      .then(async () => {
        if (shouldDelay) {
          const delayMs = resolveHumanDelayMs(options.humanDelay);
          if (delayMs > 0) await sleep(delayMs);
        }
        const info = { kind };
        let deliverPayload = normalized;
        if (beforeDeliver) {
          try {
            deliverPayload = await beforeDeliver(normalized, info);
          } catch (error) {
            try { await options.onBeforeDeliverCancelled?.(normalized, info); }
            catch (cancelError) { void options.onError?.(cancelError, info); }
            throw error;
          }
          if (!deliverPayload) {
            cancelledCounts[kind] += 1;
            try { await options.onBeforeDeliverCancelled?.(normalized, info); }
            catch (error) { void options.onError?.(error, info); }
            return;
          }
        }
        await options.deliver(deliverPayload, info);
      })
      .catch((error) => {
        failedCounts[kind] += 1;
        void options.onError?.(error, { kind });
      })
      .finally(() => {
        try { options.onDeliverySettled?.({ kind }); }
        catch (error) { void options.onError?.(error, { kind }); }
        pending -= 1;
        if (pending === 1 && completeCalled) pending -= 1;
        notifyIdle();
      });
    return true;
  };

  const markComplete = () => {
    if (completeCalled) return;
    completeCalled = true;
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        pending -= 1;
        notifyIdle();
      }
    });
  };

  return {
    sendToolResult: payload => enqueue('tool', payload),
    sendBlockReply: payload => enqueue('block', payload),
    sendFinalReply: payload => enqueue('final', payload),
    appendBeforeDeliver: (hook) => {
      const previous = beforeDeliver;
      beforeDeliver = previous
        ? async (payload, info) => {
            const previousPayload = await previous(payload, info);
            return previousPayload ? hook(previousPayload, info) : null;
          }
        : hook;
    },
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    getCancelledCounts: () => ({ ...cancelledCounts }),
    getFailedCounts: () => ({ ...failedCounts }),
    markComplete,
    resolveFollowupAdmissionBarrierTimeoutPolicy:
      typeof options.resolveFollowupAdmissionBarrierTimeoutPolicy === 'function'
        ? () => options.resolveFollowupAdmissionBarrierTimeoutPolicy({
            queuedCounts: { ...queuedCounts },
            humanDelayBudgetMs: Math.max(0, queuedCounts.block - 1) * Math.max(0, Number(options.humanDelay?.maxMs) || 0),
          })
        : undefined,
  };
}

function createReplyDispatcherWithTyping(options = {}) {
  const {
    typingCallbacks,
    onReplyStart,
    onIdle,
    onCleanup,
    onSettled: _onSettled,
    onFreshSettledDelivery: _onFreshSettledDelivery,
    ...dispatcherOptions
  } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
  let typingController;
  let dispatcher;
  const dispatchIdle = () => {
    typingController?.markDispatchIdle?.();
    const idleResult = resolvedOnIdle?.();
    observeIdleCompletion(dispatcher, idleResult);
    return idleResult;
  };
  dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: dispatchIdle,
  });
  return {
    dispatcher,
    replyOptions: {
      onReplyStart: resolvedOnReplyStart,
      onTypingCleanup: resolvedOnCleanup,
      onTypingController: typing => { typingController = typing; },
    },
    markDispatchIdle: dispatchIdle,
    markRunComplete: () => typingController?.markRunComplete?.(),
  };
}

async function waitForReplyDispatcherIdle(dispatcher, abortSignal) {
  if (!abortSignal) return dispatcher.waitForIdle();
  if (abortSignal.aborted) return;
  let removeAbortListener;
  const aborted = new Promise(resolve => {
    const onAbort = () => resolve();
    abortSignal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => abortSignal.removeEventListener('abort', onAbort);
  });
  try { await Promise.race([dispatcher.waitForIdle(), aborted]); }
  finally { removeAbortListener?.(); }
}

async function settleReplyDispatcher({ dispatcher, onSettled }) {
  dispatcher.markComplete();
  try { await dispatcher.waitForIdle(); }
  finally { await onSettled?.(); }
}

async function withReplyDispatcher({ dispatcher, run, onSettled }) {
  try { return await run(); }
  finally { await settleReplyDispatcher({ dispatcher, onSettled }); }
}

// --- reply reference ---

function createReplyReferencePlanner(_params) {
  return {
    plan: () => ({ shouldReference: false }),
  };
}

// --- auto topic label ---

function resolveAutoTopicLabelConfig(_cfg, _params) {
  return { enabled: false };
}

async function generateTopicLabel(_params) {
  return undefined;
}

export {
  // chunk
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
  // dispatch
  dispatchInboundMessage,
  dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher,
  // group activation
  normalizeGroupActivation,
  parseActivationCommand,
  // heartbeat
  HEARTBEAT_PROMPT,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
  // heartbeat reply payload
  resolveHeartbeatReplyPayload,
  // reply
  getReplyFromConfig,
  // tokens
  HEARTBEAT_TOKEN,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  // abort
  isAbortRequestText,
  // btw
  isBtwRequestText,
  // inbound dedupe
  resetInboundDedupe,
  // inbound context
  finalizeInboundContext,
  // provider dispatcher
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchReplyWithDispatcher,
  // reply dispatcher
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  observeReplyDispatcherIdle,
  waitForReplyDispatcherIdle,
  settleReplyDispatcher,
  withReplyDispatcher,
  // reply reference
  createReplyReferencePlanner,
  // auto topic label
  resolveAutoTopicLabelConfig,
  generateTopicLabel,
};
