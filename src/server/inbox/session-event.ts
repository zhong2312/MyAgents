import {
  SESSION_EVENT_TAG,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '../../shared/systemReminder';

export type SessionEventType =
  | 'send.request'
  | 'send.result'
  | 'watch.already_idle'
  | 'watch.completed'
  | 'watch.error'
  | 'space.issue_delivery';

export type SourceNotification = 'auto' | 'none';
export type SessionEventStatus = 'ok' | 'error';

interface SessionEventBase {
  version: 1 | 2;
  type: SessionEventType;
  eventId: string;
  createdAt: string;
  sourceSessionId?: string;
  sourceLabel?: string;
  targetSessionId?: string;
  targetLabel?: string;
}

export interface SendRequestEvent extends SessionEventBase {
  type: 'send.request';
  sourceSessionId: string;
  targetSessionId: string;
  sourceNotification: SourceNotification;
  payload: string;
}

export interface SendResultEvent extends SessionEventBase {
  type: 'send.result';
  sourceSessionId: string;
  targetSessionId: string;
  requestEventId?: string;
  status: SessionEventStatus;
  terminalReason?: string;
  errorCode?: string;
  payload: string;
}

export interface WatchEvent extends SessionEventBase {
  type: 'watch.already_idle' | 'watch.completed' | 'watch.error';
  watchId: string;
  sourceSessionId: string;
  targetSessionId: string;
  targetStateAtRegistration: string;
  finalState?: string;
  terminalReason?: string;
  latestResult: string;
}

export interface SpaceIssueDeliveryEvent extends SessionEventBase {
  type: 'space.issue_delivery';
  spaceId: string;
  registeredAgentId: string;
  deliveryId: string;
  deliveryKind?: 'subscription' | 'assignment' | 'claim_followup' | string | null;
  deliveryReason?: 'issue_update' | 'subscription_backfill' | 'scope_reevaluation' | string | null;
  claimId?: string | null;
  issueId: string;
  issueTitle: string;
  issueState: string;
  goalId?: string | null;
  goalPathLabel?: string | null;
  notificationVersion?: number;
  sourceIssueUpdateId?: string;
  fromNotificationVersionExclusive?: number;
  toNotificationVersionInclusive?: number;
  protocolVersion?: 2;
  instructionRevision?: number;
  deliveryCount?: number;
  updateSummary?: string | null;
}

export type SessionEvent = SendRequestEvent | SendResultEvent | WatchEvent | SpaceIssueDeliveryEvent;
type RenderableSessionEvent = Exclude<SessionEvent, SpaceIssueDeliveryEvent>;

const HTML_ESCAPE_MAP: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
};

const TAG_BRACKET_OPEN = '[<\\uFF1C]';
const TAG_BRACKET_CLOSE = '[>\\uFF1E]';

const STRUCTURAL_TAGS = [
  'myagents-session-event',
  'event-summary',
  'payload',
  'latest-result',
  'inbox-message',
  'inbox-reply',
  'system-reminder',
];

export function sanitizeSessionEventAttribute(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw.replace(/[<>&"']/g, (c) => HTML_ESCAPE_MAP[c]!);
}

export function neutralizeSessionEventStructuralTags(body: string): string {
  let safe = body;
  for (const tag of STRUCTURAL_TAGS) {
    safe = safe
      .replace(
        new RegExp(`${TAG_BRACKET_OPEN}/${tag}\\s*${TAG_BRACKET_CLOSE}`, 'gi'),
        `&lt;/${tag}&gt;`,
      )
      .replace(
        new RegExp(`${TAG_BRACKET_OPEN}${tag}\\b`, 'gi'),
        `&lt;${tag}`,
      );
  }
  return safe;
}

function attr(name: string, value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${name}="${sanitizeSessionEventAttribute(String(value))}"`;
}

function assertRenderableSessionEvent(event: SessionEvent): asserts event is RenderableSessionEvent {
  if (event.type === 'space.issue_delivery') {
    throw new Error('space.issue_delivery prompts are rendered by Rust and must bypass renderSessionEventPrompt');
  }
}

function isWatchEvent(event: RenderableSessionEvent): event is WatchEvent {
  return event.type === 'watch.already_idle'
    || event.type === 'watch.completed'
    || event.type === 'watch.error';
}

function renderOpenTag(event: RenderableSessionEvent): string {
  const attrs = [
    attr('version', event.version),
    attr('type', event.type),
    attr('event_id', event.eventId),
    attr('source_session_id', event.sourceSessionId),
    attr('source_label', event.sourceLabel),
    attr('target_session_id', event.targetSessionId),
    attr('target_label', event.targetLabel),
    event.type === 'send.request' ? attr('source_notification', event.sourceNotification) : null,
    event.type === 'send.result' ? attr('request_event_id', event.requestEventId) : null,
    event.type === 'send.result' ? attr('status', event.status) : null,
    event.type === 'send.result' ? attr('terminal_reason', event.terminalReason) : null,
    event.type === 'send.result' ? attr('error_code', event.errorCode) : null,
    isWatchEvent(event) ? attr('watch_id', event.watchId) : null,
    isWatchEvent(event)
      ? attr('target_state_at_registration', event.targetStateAtRegistration)
      : null,
    isWatchEvent(event) ? attr('final_state', event.finalState) : null,
    isWatchEvent(event) ? attr('terminal_reason', event.terminalReason) : null,
    attr('created_at', event.createdAt),
  ].filter(Boolean);

  return `<myagents-session-event\n  ${attrs.join('\n  ')}>`;
}

function summaryForEvent(event: RenderableSessionEvent): string {
  switch (event.type) {
    case 'send.request':
      return event.sourceNotification === 'none'
        ? "Another MyAgents session sent this session a one-way request or notification. The source session will not automatically receive this turn's final result."
        : "Another MyAgents session sent this session a request. Work on it normally in this session. When this turn finishes, MyAgents will automatically deliver this turn's final result back to the source session.";
    case 'send.result':
      return event.status === 'error'
        ? 'MyAgents attempted to deliver the final result of the target session turn triggered by your previous `session send` request, but that turn did not complete successfully.'
        : 'MyAgents automatically delivered the final result of the target session turn triggered by your previous `session send` request.';
    case 'watch.already_idle':
      return 'The target session was already idle when this watch was registered, so no long-running watcher was created.';
    case 'watch.completed':
      return 'The watched target session has finished the turn that was active when this watch was registered.';
    case 'watch.error':
      return 'MyAgents could not confirm normal completion for the watched target session.';
  }
}

function payloadForEvent(event: RenderableSessionEvent): string {
  if (isWatchEvent(event)) {
    const result = neutralizeSessionEventStructuralTags(event.latestResult || '(no text response)');
    return `<latest-result>\n${result}\n</latest-result>`;
  }
  return neutralizeSessionEventStructuralTags(event.payload || '(no text response)');
}

export function renderSessionEventPrompt(event: SessionEvent): string {
  assertRenderableSessionEvent(event);
  return [
    SYSTEM_REMINDER_OPEN,
    renderOpenTag(event),
    '<event-summary>',
    summaryForEvent(event),
    '</event-summary>',
    '<payload>',
    payloadForEvent(event),
    '</payload>',
    `</${SESSION_EVENT_TAG}>`,
    SYSTEM_REMINDER_CLOSE,
  ].join('\n');
}
