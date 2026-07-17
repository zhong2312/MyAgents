import {
  normalizeSessionOrigin,
  type SessionOrigin,
} from '../../shared/session-origin';
import { isSystemMaintenanceKind } from '../../shared/managedScheduledJob';
import { parseLeadingSystemReminder } from '../../shared/systemReminder';
import type { SystemMaintenanceSessionKind } from '../../shared/managedScheduledJob';
import type { TurnTerminalOutcome } from './turn-queue';
import { heartbeatAcknowledgementHasSubstantiveRemainder } from './heartbeat-ack';

export interface SessionActivityTurnFacts {
  origin?: SessionOrigin;
  inputText: string;
  systemMaintenanceKind?: SystemMaintenanceSessionKind;
}

const MEMORY_REMINDER_KIND = 'MEMORY_UPDATE';
const HEARTBEAT_REMINDER_KIND = 'HEARTBEAT';

function isKnownOrigin(origin: SessionOrigin | undefined): origin is SessionOrigin {
  return Boolean(origin && (origin.kind !== 'unknown' || origin.surface !== 'unknown'));
}

function isMemoryTurn(facts: SessionActivityTurnFacts): boolean {
  const origin = normalizeSessionOrigin(facts.origin);
  if (isKnownOrigin(origin)) return origin.surface === 'memory_update';
  return parseLeadingSystemReminder(facts.inputText).kind === MEMORY_REMINDER_KIND;
}

function isHeartbeatTurn(facts: SessionActivityTurnFacts): boolean {
  const origin = normalizeSessionOrigin(facts.origin);
  if (isKnownOrigin(origin)) return origin.surface === 'channel_heartbeat';
  return parseLeadingSystemReminder(facts.inputText).kind === HEARTBEAT_REMINDER_KIND;
}

function heartbeatHasVisibleWork(inputText: string): boolean {
  const reminder = parseLeadingSystemReminder(inputText);
  return reminder.visibleText.trim().length > 0;
}

function isSystemMaintenanceTurn(facts: SessionActivityTurnFacts): boolean {
  return isSystemMaintenanceKind(facts.systemMaintenanceKind);
}

export function shouldRecordAdmissionActivity(facts: SessionActivityTurnFacts): boolean {
  if (isSystemMaintenanceTurn(facts) || isMemoryTurn(facts)) return false;
  if (isHeartbeatTurn(facts)) return heartbeatHasVisibleWork(facts.inputText);
  return true;
}

export function shouldRecordTerminalActivity(
  facts: SessionActivityTurnFacts,
  outcome: Pick<TurnTerminalOutcome, 'text'>,
): boolean {
  if (isSystemMaintenanceTurn(facts) || isMemoryTurn(facts)) return false;
  if (!isHeartbeatTurn(facts)) return true;
  return heartbeatHasVisibleWork(facts.inputText)
    || heartbeatAcknowledgementHasSubstantiveRemainder(outcome.text);
}
