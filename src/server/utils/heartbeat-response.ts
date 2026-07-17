import { stripHeartbeatAcknowledgement } from '../session-core/heartbeat-ack';

/**
 * Strip HEARTBEAT_OK from a heartbeat response and decide whether anything
 * user-visible remains for channel delivery. `ackMaxChars` is a delivery
 * policy and must not be reused to decide Session activity.
 */
export function stripHeartbeatToken(
  text: string,
  ackMaxChars: number,
): { status: 'silent'; reason: 'empty' | 'heartbeat_ok' } | { status: 'content'; text: string } {
  if (!text || !text.trim()) {
    return { status: 'silent', reason: 'empty' };
  }

  const acknowledgement = stripHeartbeatAcknowledgement(text);
  if (!acknowledgement.hadAcknowledgement) {
    return { status: 'content', text };
  }

  if (acknowledgement.remainder.length <= ackMaxChars) {
    return { status: 'silent', reason: 'heartbeat_ok' };
  }

  return { status: 'content', text: acknowledgement.remainder };
}
