import { createHash } from 'crypto';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_SAME_CALL_LIMIT = 6;
const DEFAULT_TOTAL_WASTED_LIMIT = 12;

type ToolCallRecord = {
  parentToolUseId: string;
  toolName: string;
  signature: string;
};

type WastedCallSample = {
  at: number;
  signature: string;
};

export type SubagentLivelockDecision = {
  parentToolUseId: string;
  toolName: string;
  repeatedCallCount: number;
  wastedCallCount: number;
};

export type SubagentLivelockGuardOptions = {
  windowMs?: number;
  sameCallLimit?: number;
  totalWastedLimit?: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function toolCallSignature(toolName: string, input: Record<string, unknown>): string {
  const serialized = JSON.stringify([toolName, canonicalize(input)]);
  return createHash('sha256').update(serialized).digest('hex');
}

function isWastedToolResult(content: string): boolean {
  return content.trimStart().toLowerCase().startsWith('wasted call');
}

/**
 * Detects active subagent livelocks where the model keeps issuing tool calls
 * that the SDK rejects as redundant. Ordinary slow work is unaffected because
 * only explicit `Wasted call` results count toward the breaker.
 */
export class SubagentLivelockGuard {
  private readonly windowMs: number;
  private readonly sameCallLimit: number;
  private readonly totalWastedLimit: number;
  private readonly callsByToolUseId = new Map<string, ToolCallRecord>();
  private readonly wastedByParent = new Map<string, WastedCallSample[]>();
  private readonly trippedParents = new Set<string>();

  constructor(options: SubagentLivelockGuardOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.sameCallLimit = options.sameCallLimit ?? DEFAULT_SAME_CALL_LIMIT;
    this.totalWastedLimit = options.totalWastedLimit ?? DEFAULT_TOTAL_WASTED_LIMIT;
  }

  recordToolUse(input: {
    parentToolUseId: string;
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): void {
    this.callsByToolUseId.set(input.toolUseId, {
      parentToolUseId: input.parentToolUseId,
      toolName: input.toolName,
      signature: toolCallSignature(input.toolName, input.toolInput),
    });
  }

  recordToolResult(
    toolUseId: string,
    content: string,
    now = Date.now(),
  ): SubagentLivelockDecision | null {
    const call = this.callsByToolUseId.get(toolUseId);
    this.callsByToolUseId.delete(toolUseId);
    if (!call || this.trippedParents.has(call.parentToolUseId)) return null;

    if (!isWastedToolResult(content)) {
      this.wastedByParent.delete(call.parentToolUseId);
      return null;
    }

    const cutoff = now - this.windowMs;
    const samples = (this.wastedByParent.get(call.parentToolUseId) ?? [])
      .filter((sample) => sample.at >= cutoff);
    samples.push({ at: now, signature: call.signature });
    this.wastedByParent.set(call.parentToolUseId, samples);

    const repeatedCallCount = samples.reduce(
      (count, sample) => count + Number(sample.signature === call.signature),
      0,
    );
    if (
      repeatedCallCount < this.sameCallLimit
      && samples.length < this.totalWastedLimit
    ) {
      return null;
    }

    this.trippedParents.add(call.parentToolUseId);
    return {
      parentToolUseId: call.parentToolUseId,
      toolName: call.toolName,
      repeatedCallCount,
      wastedCallCount: samples.length,
    };
  }

  clearParent(parentToolUseId: string): void {
    this.wastedByParent.delete(parentToolUseId);
    this.trippedParents.delete(parentToolUseId);
    for (const [toolUseId, call] of this.callsByToolUseId) {
      if (call.parentToolUseId === parentToolUseId) {
        this.callsByToolUseId.delete(toolUseId);
      }
    }
  }
}

