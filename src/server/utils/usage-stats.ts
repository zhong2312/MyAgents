import type { MessageUsage, SessionData, SessionMessage } from '../types/session';
import { isHumanUserMessage, resolveVisibleUserTurnText } from './session-message-preview';

export interface UsageByModelEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  count: number;
  model: string;
  providerId?: string;
}

export type UsageByModel = Record<string, UsageByModelEntry>;

export interface UsageStatsSummary {
  turnCount: number;
  humanQueryCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface GlobalUsageStats {
  summary: UsageStatsSummary & { totalSessions: number };
  daily: Array<{
    date: string;
    turnCount: number;
    humanQueryCount: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byModel: UsageByModel;
}

export interface SessionDetailedUsageStats {
  summary: UsageStatsSummary;
  byModel: UsageByModel;
  details: Array<{
    turnTrigger: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    toolCount?: number;
    durationMs?: number;
  }>;
}

function usageModelKey(model: string, providerId?: string): string {
  return providerId ? JSON.stringify([providerId, model]) : model;
}

function usageProviderId(usage: MessageUsage, fallbackProviderId?: string): string | undefined {
  const providerId = usage.providerId ?? fallbackProviderId;
  return typeof providerId === 'string' && providerId.trim() ? providerId : undefined;
}

export function addUsageToByModel(
  byModel: UsageByModel,
  model: string,
  stats: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
  providerId?: string,
): void {
  const key = usageModelKey(model, providerId);
  if (!byModel[key]) {
    byModel[key] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      count: 0,
      model,
      ...(providerId ? { providerId } : {}),
    };
  }
  byModel[key].inputTokens += stats.inputTokens ?? 0;
  byModel[key].outputTokens += stats.outputTokens ?? 0;
  byModel[key].cacheReadTokens += stats.cacheReadTokens ?? 0;
  byModel[key].cacheCreationTokens += stats.cacheCreationTokens ?? 0;
  byModel[key].count++;
}

export function addMessageUsageToByModel(
  byModel: UsageByModel,
  message: Pick<SessionMessage, 'usage'>,
  fallbackProviderId?: string,
): void {
  const usage = message.usage;
  if (!usage) return;

  const providerId = usageProviderId(usage, fallbackProviderId);
  if (usage.modelUsage && Object.keys(usage.modelUsage).length > 0) {
    for (const [model, stats] of Object.entries(usage.modelUsage)) {
      addUsageToByModel(byModel, model, stats, providerId);
    }
    return;
  }

  addUsageToByModel(byModel, usage.model || 'unknown', usage, providerId);
}

function localDateKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptySummary(): UsageStatsSummary {
  return {
    turnCount: 0,
    humanQueryCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  };
}

export function aggregateGlobalUsageStats(
  sessions: readonly SessionData[],
  cutoffMs: number,
): GlobalUsageStats {
  const summary = { ...emptySummary(), totalSessions: 0 };
  const dailyMap = new Map<string, GlobalUsageStats['daily'][number]>();
  const byModel: UsageByModel = {};

  for (const session of sessions) {
    let hasInRangeMessage = false;
    for (const message of session.messages) {
      const timestampMs = Date.parse(message.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs) continue;

      hasInRangeMessage = true;
      const date = localDateKey(timestampMs);
      let daily = dailyMap.get(date);
      if (!daily) {
        daily = { date, turnCount: 0, humanQueryCount: 0, inputTokens: 0, outputTokens: 0 };
        dailyMap.set(date, daily);
      }

      if (message.role === 'user') {
        summary.turnCount++;
        daily.turnCount++;
        if (isHumanUserMessage(message, session.origin)) {
          summary.humanQueryCount++;
          daily.humanQueryCount++;
        }
        continue;
      }

      if (!message.usage) continue;
      summary.totalInputTokens += message.usage.inputTokens ?? 0;
      summary.totalOutputTokens += message.usage.outputTokens ?? 0;
      summary.totalCacheReadTokens += message.usage.cacheReadTokens ?? 0;
      summary.totalCacheCreationTokens += message.usage.cacheCreationTokens ?? 0;
      daily.inputTokens += message.usage.inputTokens ?? 0;
      daily.outputTokens += message.usage.outputTokens ?? 0;
      addMessageUsageToByModel(byModel, message, session.providerId);
    }
    if (hasInRangeMessage) summary.totalSessions++;
  }

  return {
    summary,
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel,
  };
}

function attachmentTurnTrigger(message: SessionMessage): string {
  const names = message.attachments?.map(attachment => attachment.name).filter(Boolean) ?? [];
  return names.length > 0 ? `📎 ${names.join(', ')}`.slice(0, 100) : '';
}

export function buildSessionDetailedUsageStats(session: SessionData): SessionDetailedUsageStats {
  const summary = emptySummary();
  const byModel: UsageByModel = {};
  const details: SessionDetailedUsageStats['details'] = [];
  let turnTrigger = '';

  for (const message of session.messages) {
    if (message.role === 'user') {
      summary.turnCount++;
      if (isHumanUserMessage(message, session.origin)) summary.humanQueryCount++;
      turnTrigger = resolveVisibleUserTurnText(message.content)?.trim().slice(0, 100)
        || attachmentTurnTrigger(message);
      continue;
    }

    if (!message.usage) continue;
    summary.totalInputTokens += message.usage.inputTokens ?? 0;
    summary.totalOutputTokens += message.usage.outputTokens ?? 0;
    summary.totalCacheReadTokens += message.usage.cacheReadTokens ?? 0;
    summary.totalCacheCreationTokens += message.usage.cacheCreationTokens ?? 0;
    addMessageUsageToByModel(byModel, message, session.providerId);
    details.push({
      turnTrigger,
      model: message.usage.model,
      inputTokens: message.usage.inputTokens ?? 0,
      outputTokens: message.usage.outputTokens ?? 0,
      cacheReadTokens: message.usage.cacheReadTokens,
      cacheCreationTokens: message.usage.cacheCreationTokens,
      toolCount: message.toolCount,
      durationMs: message.durationMs,
    });
  }

  return { summary, byModel, details };
}
