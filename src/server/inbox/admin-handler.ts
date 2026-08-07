// Session Inbox admin API handler — POST /api/session/inbox (PRD 0.2.18 §5.2).
//
// 由 CLI `myagents session send` 通过 sidecar admin API 调用。流程:
//   1. 解析 body: { toSessionId, prompt, replyBack }
//   2. 推导 caller label(从本 sidecar 的 session metadata)
//   3. 构造 PendingInboxMessage(kind=Request)
//   4. 查 target session 的 workspace path(从 SessionStore;同 agent 同盘)
//   5. POST 到 Rust /api/inbox/deliver
//   6. Rust 内部:查 target sidecar → push + HTTP /api/inbox/drain
//   7. 把 DeliverOutcome 转换为 admin API 响应

import { randomUUID } from 'crypto';
import { cancellableFetch } from '../utils/cancellation';
import { sanitizeInboxLabel } from './sanitize-label';
import { deriveSessionLabel } from './derive-label';
import { getSessionMetadata, getSessionData } from '../SessionStore';
import type { PendingInboxMessage, DeliverOutcome } from './types';
import type { SessionMetadata } from '../types/session';

/// Request body shape — matches CLI surface (`-p` / `--no-reply`)
export interface AdminInboxRequest {
  /** Target session id (must exist) */
  toSessionId: string;
  /** Prompt text (CLI -p / --prompt or --prompt-file content) */
  prompt: string;
  /** Whether to push target's turn output back to caller (default true) */
  replyBack: boolean;
}

/// Response shape — used by CLI for success/error display + exit code
export interface AdminInboxResponse {
  delivered: boolean;
  /** Echoed back label so CLI can show e.g. "Sent as 'Cron: ...' " */
  fromLabel?: string;
  /** UUID of the dispatched message — used by debug logs / reply correlation */
  messageId?: string;
  /** Whether MyAgents will push the target turn result back to the caller. */
  replyBack?: boolean;
  /** Error code when delivered=false:
   *  'session_not_found' | 'delivery_failed' | 'invalid_args' | 'rejected' */
  error?: { code: string; message: string };
}

/// First user message extractor for unnamed desktop sessions in derive-label.
/// Empty string when not derivable (will fall back to "桌面对话").
function getFirstUserMessageText(sessionId: string): string {
  try {
    const data = getSessionData(sessionId);
    if (!data) return '';
    for (const msg of data.messages) {
      if (msg.role === 'user') {
        const content = msg.content;
        if (typeof content === 'string') return content;
        return '';
      }
    }
  } catch {
    // Don't fail derive-label over storage hiccups
  }
  return '';
}

export function deriveCallerInboxLabel(
  callerSessionId: string,
  callerMeta: SessionMetadata | null = getSessionMetadata(callerSessionId) ?? null,
): string {
  const rawLabel = deriveSessionLabel(
    callerMeta,
    callerMeta ? getFirstUserMessageText(callerSessionId) : undefined,
  );
  return sanitizeInboxLabel(rawLabel);
}

/// Build the PendingInboxMessage envelope (kind=Request) from admin API input.
function buildRequestMessage(
  callerSessionId: string,
  callerMeta: SessionMetadata | null,
  toSessionId: string,
  prompt: string,
  replyBack: boolean,
): PendingInboxMessage {
  // sanitize at construction; recipients will receive only sanitized form
  const fromLabel = deriveCallerInboxLabel(callerSessionId, callerMeta);

  const messageId = randomUUID();
  const createdAt = new Date().toISOString();

  return {
    messageId,
    fromSessionId: callerSessionId,
    fromLabel,
    toSessionId,
    text: prompt,
    replyBack,
    timestampMs: Date.now(),
    kind: 'request',
    inReplyTo: null,
    sessionEvent: {
      version: 1,
      type: 'send.request',
      eventId: messageId,
      sourceSessionId: callerSessionId,
      sourceLabel: fromLabel,
      targetSessionId: toSessionId,
      sourceNotification: replyBack ? 'auto' : 'none',
      createdAt,
      payload: prompt,
    },
  };
}

/// Resolve target session workspace path for dead-session resume.
/// Returns undefined if target session metadata not accessible (e.g. cross-agent),
/// in which case the Rust deliver path returns SessionNotFound for dead targets.
function resolveResumeWorkspacePath(toSessionId: string): string | undefined {
  const meta = getSessionMetadata(toSessionId);
  if (!meta) return undefined;
  return meta.agentDir;
}

/// Main entry: handle POST /api/session/inbox.
/// `callerSessionId` is the current sidecar's session id (caller).
export async function handleAdminInbox(
  callerSessionId: string,
  body: AdminInboxRequest,
): Promise<{ status: number; response: AdminInboxResponse }> {
  // Validation
  if (!body.toSessionId || typeof body.toSessionId !== 'string') {
    return {
      status: 400,
      response: {
        delivered: false,
        error: { code: 'invalid_args', message: 'toSessionId is required' },
      },
    };
  }
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    return {
      status: 400,
      response: {
        delivered: false,
        error: { code: 'invalid_args', message: 'prompt is required and non-empty' },
      },
    };
  }
  // Require callerSessionId to be present — without it, "send to self" check
  // is meaningless (empty === empty would slip through). PRD 0.2.18 cross-
  // review CC: empty-empty match was a soft hole.
  if (!callerSessionId) {
    return {
      status: 500,
      response: {
        delivered: false,
        error: { code: 'delivery_failed', message: 'caller sidecar has no session id (not initialized)' },
      },
    };
  }
  if (body.toSessionId === callerSessionId) {
    return {
      status: 400,
      response: {
        delivered: false,
        error: { code: 'invalid_args', message: 'cannot send to self' },
      },
    };
  }

  // Derive caller label from this sidecar's metadata
  const callerMeta = getSessionMetadata(callerSessionId) ?? null;

  // Build envelope
  const message = buildRequestMessage(
    callerSessionId,
    callerMeta,
    body.toSessionId,
    body.prompt,
    body.replyBack !== false, // default true
  );

  // Resolve target workspace_path for dead-session resume
  const resumeWorkspacePath = resolveResumeWorkspacePath(body.toSessionId);

  // POST to Rust management API
  const managementPort = process.env.MYAGENTS_MANAGEMENT_PORT;
  if (!managementPort) {
    return {
      status: 500,
      response: {
        delivered: false,
        error: { code: 'delivery_failed', message: 'MYAGENTS_MANAGEMENT_PORT not set' },
      },
    };
  }

  let resp: Response;
  try {
    resp = await cancellableFetch(
      `http://127.0.0.1:${managementPort}/api/inbox/deliver`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          resumeWorkspacePath,
        }),
      },
      // Match Rust-side timeout (local_http::json_client(Duration::from_secs(30))).
      // Cross-review CC: TS 60s wrapping Rust 30s wasted the outer; Rust returns
      // first so the outer never fires.
      { timeoutMs: 30_000 },
    );
  } catch (err) {
    console.error('[inbox/admin] HTTP to management API failed:', err);
    return {
      status: 502,
      response: {
        delivered: false,
        fromLabel: message.fromLabel,
        messageId: message.messageId,
        error: {
          code: 'delivery_failed',
          message: `management API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      },
    };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return {
      status: 502,
      response: {
        delivered: false,
        fromLabel: message.fromLabel,
        messageId: message.messageId,
        error: {
          code: 'delivery_failed',
          message: `management API ${resp.status}: ${text.slice(0, 200)}`,
        },
      },
    };
  }

  const json = (await resp.json().catch(() => null)) as
    | { ok: boolean; outcome?: DeliverOutcome; error?: string }
    | null;
  if (!json || !json.ok) {
    return {
      status: 502,
      response: {
        delivered: false,
        fromLabel: message.fromLabel,
        messageId: message.messageId,
        error: {
          code: 'delivery_failed',
          message: json?.error ?? 'management API returned ok=false',
        },
      },
    };
  }

  const outcome = json.outcome;
  if (!outcome) {
    return {
      status: 502,
      response: {
        delivered: false,
        fromLabel: message.fromLabel,
        messageId: message.messageId,
        error: { code: 'delivery_failed', message: 'no outcome in management API response' },
      },
    };
  }

  switch (outcome.status) {
    case 'delivered':
      return {
        status: 200,
        response: {
          delivered: true,
          fromLabel: message.fromLabel,
          messageId: outcome.message_id,
          replyBack: message.replyBack,
        },
      };
    case 'session_not_found':
      return {
        status: 404,
        response: {
          delivered: false,
          fromLabel: message.fromLabel,
          messageId: message.messageId,
          error: {
            code: 'session_not_found',
            message: `target session ${body.toSessionId} not found or not deliverable`,
          },
        },
      };
    case 'rejected':
      return {
        status: 409,
        response: {
          delivered: false,
          fromLabel: message.fromLabel,
          messageId: message.messageId,
          error: { code: 'rejected', message: outcome.reason },
        },
      };
    case 'delivery_failed':
    default:
      return {
        status: 502,
        response: {
          delivered: false,
          fromLabel: message.fromLabel,
          messageId: message.messageId,
          error: {
            code: 'delivery_failed',
            message: outcome.status === 'delivery_failed' ? outcome.reason : 'unknown outcome',
          },
        },
      };
  }
}
