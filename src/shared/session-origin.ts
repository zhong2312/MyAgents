export type OriginKind =
  | 'desktop'
  | 'automation'
  | 'agent-channel'
  | 'registered-agent'
  | 'session-inbox'
  | 'unknown';

export type OriginSurface =
  | 'launcher_input'
  | 'agent_card'
  | 'new_chat_button'
  | 'task_center'
  | 'assistant'
  | 'agent_setup'
  | 'floating_ball'
  | 'session_fork'
  | 'cmd_k'
  | 'external_link'
  | 'cron'
  | 'task_run'
  | 'memory_update'
  | 'channel_message'
  | 'channel_heartbeat'
  | 'space_issue_delivery'
  | 'session_send'
  | 'session_reply'
  | 'unknown';

export type RegisteredAgentSessionOrigin = {
  kind: 'registered-agent';
  surface: 'space_issue_delivery';
  context: {
    spaceId: string;
    registeredAgentId: string;
  };
};

export type SessionOrigin = RegisteredAgentSessionOrigin | {
  kind: Exclude<OriginKind, 'registered-agent'>;
  surface: Exclude<OriginSurface, 'space_issue_delivery'>;
};

export type OriginAnalyticsFields = {
  origin_kind: OriginKind;
  origin_surface: OriginSurface;
};

export {
  isSystemMaintenanceKind,
  isSystemMaintenanceSession,
  normalizeSystemMaintenanceKind,
  type SystemMaintenanceSessionKind,
} from './managedScheduledJob';

export const UNKNOWN_SESSION_ORIGIN: SessionOrigin = {
  kind: 'unknown',
  surface: 'unknown',
};

const ORIGIN_KINDS: readonly OriginKind[] = [
  'desktop',
  'automation',
  'agent-channel',
  'registered-agent',
  'session-inbox',
  'unknown',
];

const ORIGIN_SURFACES: readonly OriginSurface[] = [
  'launcher_input',
  'agent_card',
  'new_chat_button',
  'task_center',
  'assistant',
  'agent_setup',
  'floating_ball',
  'session_fork',
  'cmd_k',
  'external_link',
  'cron',
  'task_run',
  'memory_update',
  'channel_message',
  'channel_heartbeat',
  'space_issue_delivery',
  'session_send',
  'session_reply',
  'unknown',
];

const ORIGIN_KIND_SET = new Set<string>(ORIGIN_KINDS);
const ORIGIN_SURFACE_SET = new Set<string>(ORIGIN_SURFACES);

export function isOriginKind(value: unknown): value is OriginKind {
  return typeof value === 'string' && ORIGIN_KIND_SET.has(value);
}

export function isOriginSurface(value: unknown): value is OriginSurface {
  return typeof value === 'string' && ORIGIN_SURFACE_SET.has(value);
}

export function normalizeSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { kind?: unknown; surface?: unknown; context?: unknown };
  if (!isOriginKind(candidate.kind) || !isOriginSurface(candidate.surface)) {
    return undefined;
  }
  const isRegisteredAgentOrigin = candidate.kind === 'registered-agent'
    || candidate.surface === 'space_issue_delivery';
  if (isRegisteredAgentOrigin) {
    if (
      candidate.kind !== 'registered-agent'
      || candidate.surface !== 'space_issue_delivery'
      || !candidate.context
      || typeof candidate.context !== 'object'
    ) {
      return undefined;
    }
    const context = candidate.context as { spaceId?: unknown; registeredAgentId?: unknown };
    if (
      typeof context.spaceId !== 'string'
      || !context.spaceId.trim()
      || typeof context.registeredAgentId !== 'string'
      || !context.registeredAgentId.trim()
    ) {
      return undefined;
    }
    return {
      kind: 'registered-agent',
      surface: 'space_issue_delivery',
      context: {
        spaceId: context.spaceId.trim(),
        registeredAgentId: context.registeredAgentId.trim(),
      },
    };
  }
  return {
    kind: candidate.kind as Exclude<OriginKind, 'registered-agent'>,
    surface: candidate.surface as Exclude<OriginSurface, 'space_issue_delivery'>,
  };
}

export function originAnalyticsFields(origin: unknown): OriginAnalyticsFields {
  const normalized = normalizeSessionOrigin(origin) ?? UNKNOWN_SESSION_ORIGIN;
  return {
    origin_kind: normalized.kind,
    origin_surface: normalized.surface,
  };
}

export function originFromDesktopSurface(surface: string | undefined | null): SessionOrigin {
  switch (surface) {
    case 'launcher_input':
    case 'agent_card':
    case 'new_chat_button':
    case 'task_center':
    case 'agent_setup':
    case 'floating_ball':
    case 'session_fork':
    case 'cmd_k':
    case 'external_link':
      return { kind: 'desktop', surface };
    case 'bug_report':
      return { kind: 'desktop', surface: 'assistant' };
    case 'cron':
      return { kind: 'automation', surface: 'cron' };
    case 'im':
      return { kind: 'agent-channel', surface: 'channel_message' };
    default:
      return { kind: 'desktop', surface: 'unknown' };
  }
}

export function originFromMaterializationScenario(scenario: string | undefined | null): SessionOrigin {
  switch (scenario) {
    case 'cron':
      return { kind: 'automation', surface: 'cron' };
    case 'im':
    case 'agent-channel':
      return { kind: 'agent-channel', surface: 'channel_message' };
    case 'registeredAgent':
    case 'registered-agent':
      // A scenario label does not contain the stable Space + Registered Agent
      // identity required for authority. The delivery ingress supplies the
      // exact origin explicitly; never invent an identity here.
      return UNKNOWN_SESSION_ORIGIN;
    case 'desktop':
      return { kind: 'desktop', surface: 'unknown' };
    default:
      return UNKNOWN_SESSION_ORIGIN;
  }
}

export function originFromTurnAttribution(input: {
  source?: string | null;
  scenarioType?: string | null;
  desktopSurface?: string | null;
  inboxMeta?: unknown;
}): SessionOrigin {
  if (input.inboxMeta) {
    return { kind: 'session-inbox', surface: 'session_send' };
  }

  const source = input.source ?? input.scenarioType ?? undefined;
  switch (source) {
    case 'floating_ball':
      return { kind: 'desktop', surface: 'floating_ball' };
    case 'cron':
      return { kind: 'automation', surface: 'cron' };
    case 'im':
    case 'agent-channel':
      return { kind: 'agent-channel', surface: 'channel_message' };
    case 'registeredAgent':
    case 'registered-agent':
      return UNKNOWN_SESSION_ORIGIN;
    case 'desktop':
      return input.desktopSurface === 'floating-ball'
        ? { kind: 'desktop', surface: 'floating_ball' }
        : { kind: 'desktop', surface: 'unknown' };
    default:
      return UNKNOWN_SESSION_ORIGIN;
  }
}

export function isAutomationHistoryOrigin(
  origin: unknown,
  legacy?: { cronTaskId?: string | null; source?: string | null },
): boolean {
  const normalized = normalizeSessionOrigin(origin);
  if (normalized) {
    return normalized.kind === 'automation'
      && (normalized.surface === 'cron' || normalized.surface === 'task_run');
  }

  // Legacy best-effort only. Do not infer from titles; absence of a durable
  // signal should keep old sessions visible instead of accidentally hiding them.
  return Boolean(legacy?.cronTaskId || legacy?.source === 'cron');
}

export function originFromSessionMetadataLike(meta: unknown): SessionOrigin {
  if (!meta || typeof meta !== 'object') return UNKNOWN_SESSION_ORIGIN;
  const candidate = meta as {
    origin?: unknown;
    cronTaskId?: unknown;
    source?: unknown;
  };
  const normalized = normalizeSessionOrigin(candidate.origin);
  if (normalized) return normalized;
  if (typeof candidate.cronTaskId === 'string' && candidate.cronTaskId) {
    return { kind: 'automation', surface: 'cron' };
  }
  if (candidate.source === 'cron') {
    return { kind: 'automation', surface: 'cron' };
  }
  return UNKNOWN_SESSION_ORIGIN;
}
