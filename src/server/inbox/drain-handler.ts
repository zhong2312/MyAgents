// Session Inbox drain handler — POST /api/inbox/drain (PRD 0.2.18).
//
// 由 Rust 端 `cmd_inbox_deliver` 在 push pending_inbox_messages 后调用,把同样
// 的 message payload 直接 POST 过来。Drain handler 取出 messages → 包裹
// MyAgents Session Event Protocol v1 prompt → 调用 enqueueUserMessage /
// sendExternalMessage 注入。Space issue delivery is the exception: Rust
// already renders the final <system-reminder> prompt so the UI can hide the
// operational payload and show a Space issue badge.
//
// 关键设计:
//   - Request 类型携带 replyBack 标记;target turn-end 时根据这个标记决定是否
//     反向推 reply(逻辑在 agent-session.ts result handler / external-session.ts
//     persistTurnResult hook 中)。
//   - Reply 类型的 replyBack 恒为 false——避免 reply 的 reply 形成无限往返。
//   - 注入时统一走 session-event renderer,避免 prompt injection
//     (`</myagents-session-event>` 闭合标签注入等)。

import { renderSessionEventPrompt } from './session-event';
import { buildInReplyToSnippet } from './types';
import type { PendingInboxMessage, DrainResponse, InboxTurnMeta } from './types';
import type { SessionEvent } from './session-event';
import type { InteractionScenario } from '../system-prompt';
import type { DispatchGuard } from '../session-core/turn-queue';
import type { InboxAdmissionResult } from '../session-engine/types';

function nowIsoFromMessage(msg: PendingInboxMessage): string {
  return new Date(msg.timestampMs || Date.now()).toISOString();
}

function legacySendRequestEvent(msg: PendingInboxMessage): SessionEvent {
  return {
    version: 1,
    type: 'send.request',
    eventId: msg.messageId,
    sourceSessionId: msg.fromSessionId,
    sourceLabel: msg.fromLabel,
    targetSessionId: msg.toSessionId,
    sourceNotification: msg.replyBack ? 'auto' : 'none',
    createdAt: nowIsoFromMessage(msg),
    payload: msg.text,
  };
}

function legacySendResultEvent(msg: PendingInboxMessage): SessionEvent {
  return {
    version: 1,
    type: 'send.result',
    eventId: msg.messageId,
    sourceSessionId: msg.fromSessionId,
    sourceLabel: msg.fromLabel,
    targetSessionId: msg.toSessionId,
    status: msg.text.startsWith('[ERROR ') ? 'error' : 'ok',
    terminalReason: msg.text.startsWith('[ERROR ') ? 'error' : 'completed',
    createdAt: nowIsoFromMessage(msg),
    payload: msg.text,
  };
}

export function buildSessionEventPrompt(msg: PendingInboxMessage): string {
  if (msg.kind === 'event' && msg.sessionEvent?.type === 'space.issue_delivery') {
    return msg.text;
  }
  if (msg.sessionEvent) {
    return renderSessionEventPrompt(msg.sessionEvent);
  }
  if (msg.kind === 'reply') {
    return renderSessionEventPrompt(legacySendResultEvent(msg));
  }
  if (msg.kind === 'event') {
    return renderSessionEventPrompt({
      version: 1,
      type: 'watch.error',
      eventId: msg.messageId,
      watchId: msg.messageId,
      sourceSessionId: msg.fromSessionId,
      sourceLabel: msg.fromLabel,
      targetSessionId: msg.toSessionId,
      targetStateAtRegistration: 'unknown',
      finalState: 'error',
      terminalReason: 'missing_session_event',
      createdAt: nowIsoFromMessage(msg),
      latestResult: msg.text || 'Missing structured session event payload.',
    });
  }
  return renderSessionEventPrompt(legacySendRequestEvent(msg));
}

/// Build per-turn InboxTurnMeta to bind on the dequeued message. Only present
/// for Request kind with replyBack=true — Reply kind never triggers further reply.
export function buildTurnMeta(msg: PendingInboxMessage): InboxTurnMeta | undefined {
  if (msg.kind === 'reply') return undefined;
  if (msg.kind === 'event') return undefined;
  if (!msg.replyBack) return undefined;
  return {
    fromSessionId: msg.fromSessionId,
    fromLabel: msg.fromLabel,
    replyBack: true,
    originalMessageId: msg.messageId,
    originalSnippet: buildInReplyToSnippet(msg.text),
  };
}

/// Function signature for the message injector. Different runtimes provide
/// different implementations — agent-session for builtin SDK, external-session
/// for CC CLI / Codex / Gemini. The wrapper passes inboxMeta along for turn-end
/// reply binding.
export type InboxInjector = (
  text: string,
  inboxMeta?: InboxTurnMeta,
  options?: {
    allowLazySessionMaterialization?: boolean;
    scenario?: InteractionScenario;
    queueId?: string;
    beforeDispatch?: DispatchGuard;
  },
) => Promise<InboxAdmissionResult>;

function scenarioForInboxMessage(msg: PendingInboxMessage): InteractionScenario | undefined {
  if (msg.kind === 'event' && msg.sessionEvent?.type === 'space.issue_delivery') {
    if (!msg.sessionEvent.spaceId.trim() || !msg.sessionEvent.registeredAgentId.trim()) {
      throw new Error('INVALID_REGISTERED_AGENT_ORIGIN: Space delivery requires exact spaceId and registeredAgentId.');
    }
    return {
      type: 'registeredAgent',
      platform: 'space',
      spaceId: msg.sessionEvent.spaceId,
      registeredAgentId: msg.sessionEvent.registeredAgentId,
      sourceType: 'issue-delivery',
    };
  }
  return undefined;
}

/// Drain handler entry — processes a batch of messages, returns aggregated response.
///
/// Currently messages always arrive in batches of size 1 from Rust (one POST
/// per cmd_inbox_deliver call), but the interface supports N for future batching.
export async function handleInboxDrain(
  messages: PendingInboxMessage[],
  injector: InboxInjector,
): Promise<DrainResponse> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { accepted: false, reason: 'empty message batch' };
  }

  let acceptedAny = false;
  const rejectReasons: string[] = [];

  for (const msg of messages) {
    try {
      const prompt = buildSessionEventPrompt(msg);
      const meta = buildTurnMeta(msg);
      const allowLazySessionMaterialization =
        msg.kind === 'event' && msg.sessionEvent?.type === 'space.issue_delivery';
      const scenario = scenarioForInboxMessage(msg);
      const result = await injector(prompt, meta, { allowLazySessionMaterialization, scenario });
      // PRD 0.2.18 cross-review fix (Codex):
      // enqueueUserMessage's `queued` flag is "queued behind other turns" not
      // "accepted vs rejected". On the idle direct-send path it returns
      // `{ queued: false }` (NO error) — that's a SUCCESS. The actual
      // failure signal is `error` (e.g. "Queue full (max 10)" / runtime errors).
      // Treating queued:false as rejection caused every idle delivery to fail
      // → CLI exit non-zero → caller AI retries duplicate prompts.
      if (!result.error) {
        acceptedAny = true;
        console.log(
          `[inbox/drain] accepted ${msg.kind} from=${msg.fromSessionId} msg_id=${msg.messageId} (queued=${result.queued})` +
            (meta ? ` (reply_back=true, will push reply on turn-end)` : ''),
        );
      } else {
        const reason = result.error;
        rejectReasons.push(`${msg.messageId}: ${reason}`);
        console.warn(`[inbox/drain] rejected msg_id=${msg.messageId}: ${reason}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      rejectReasons.push(`${msg.messageId}: ${reason}`);
      console.error(`[inbox/drain] inject failed for ${msg.messageId}:`, err);
    }
  }

  if (acceptedAny) {
    // At least one queued — treat batch as accepted; per-message rejects are logged.
    return { accepted: true };
  }
  return { accepted: false, reason: rejectReasons.join('; ') || 'all messages rejected' };
}
