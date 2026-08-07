import type { MessageWire } from '../builtin-session/types';

type UnknownRecord = Record<string, unknown>;

export type MalformedToolHistoryIssue = {
  messageIndex: number;
  blockIndex: number;
  kind: 'tool_use' | 'tool_result';
  reason: 'missing_id' | 'missing_name' | 'missing_tool_use_id';
};

export type MalformedToolHistoryRepair = {
  messages: MessageWire[];
  issues: MalformedToolHistoryIssue[];
  changedMessageIds: string[];
  removedMessageIds: string[];
  removedSdkUuids: string[];
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function inspectToolBlock(
  block: unknown,
  messageIndex: number,
  blockIndex: number,
): MalformedToolHistoryIssue[] {
  if (!isRecord(block)) return [];

  if (block.type === 'tool_use') {
    const payload = isRecord(block.tool) ? block.tool : block;
    const issues: MalformedToolHistoryIssue[] = [];
    if (!isNonBlankString(payload.id)) {
      issues.push({ messageIndex, blockIndex, kind: 'tool_use', reason: 'missing_id' });
    }
    if (!isNonBlankString(payload.name)) {
      issues.push({ messageIndex, blockIndex, kind: 'tool_use', reason: 'missing_name' });
    }
    return issues;
  }

  if (block.type === 'tool_result' && !isNonBlankString(block.tool_use_id)) {
    return [{
      messageIndex,
      blockIndex,
      kind: 'tool_result',
      reason: 'missing_tool_use_id',
    }];
  }

  return [];
}

function inspectContent(content: unknown, messageIndex: number): MalformedToolHistoryIssue[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, blockIndex) => inspectToolBlock(block, messageIndex, blockIndex));
}

export function findMalformedToolHistory(
  messages: readonly MessageWire[],
): MalformedToolHistoryIssue[] {
  return messages.flatMap((message, messageIndex) =>
    inspectContent(message.content, messageIndex));
}

/** Inspect raw Claude Agent SDK messages without depending on its evolving union types. */
export function findMalformedSdkToolHistory(messages: readonly unknown[]): MalformedToolHistoryIssue[] {
  const issues: MalformedToolHistoryIssue[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) return;
    const nestedMessage = isRecord(message.message) ? message.message : undefined;
    const content = nestedMessage?.content ?? message.content;
    issues.push(...inspectContent(content, messageIndex));
  });
  return issues;
}

export function hasMalformedRawToolContent(content: unknown): boolean {
  return inspectContent(content, 0).length > 0;
}

export function repairMalformedToolHistory(
  messages: readonly MessageWire[],
): MalformedToolHistoryRepair {
  const issues: MalformedToolHistoryIssue[] = [];
  const changedMessageIds: string[] = [];
  const removedMessageIds: string[] = [];
  const removedSdkUuids: string[] = [];
  const repaired: MessageWire[] = [];

  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      return;
    }

    const nextContent = message.content.filter((block, blockIndex) => {
      const blockIssues = inspectToolBlock(block, messageIndex, blockIndex);
      issues.push(...blockIssues);
      return blockIssues.length === 0;
    });

    if (nextContent.length === message.content.length) {
      repaired.push(message);
      return;
    }

    if (nextContent.length === 0) {
      removedMessageIds.push(message.id);
      if (message.sdkUuid) removedSdkUuids.push(message.sdkUuid);
      return;
    }

    changedMessageIds.push(message.id);
    repaired.push({ ...message, content: nextContent });
  });

  return {
    messages: repaired,
    issues,
    changedMessageIds,
    removedMessageIds,
    removedSdkUuids,
  };
}

export function nextMalformedToolRecoveryAttempt(currentAttempt = 0): number | null {
  return currentAttempt < 1 ? currentAttempt + 1 : null;
}

export function isInvalidProviderParameterError(errorMessage: string): boolean {
  return /(?:API\s+Error:\s*)?400\b/i.test(errorMessage)
    && /parameter[^\n]*not valid|invalid[^\n]*parameter/i.test(errorMessage);
}
