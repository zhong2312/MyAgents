type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

function safeProtocolLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Redact every SDK payload before it enters unified or session logs. SDK
 * messages can contain workspace/plugin paths, prompts, assistant output,
 * peer bodies, tool results, errors, and session identifiers. This function
 * is deliberately fail-closed: message families get an explicit metadata
 * whitelist, while unknown families retain protocol labels only.
 */
export function summarizeSensitiveSdkMessage(message: unknown): unknown {
  if (!isRecord(message)) return { type: 'unknown' };

  if (message.type === 'system' && message.subtype === 'init') {
    return {
      type: 'system',
      subtype: 'init',
      model: safeLabel(message.model),
      permissionMode: safeLabel(message.permissionMode),
      toolCount: arrayLength(message.tools),
      mcpServerCount: arrayLength(message.mcp_servers),
      pluginCount: arrayLength(message.plugins),
      skillCount: arrayLength(message.skills),
      agentCount: arrayLength(message.agents),
      slashCommandCount: arrayLength(message.slash_commands),
      capabilityCount: arrayLength(message.capabilities),
    };
  }

  if (message.type === 'result') {
    const usage = isRecord(message.usage) ? message.usage : {};
    const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : {};
    return {
      type: 'result',
      subtype: safeLabel(message.subtype),
      isError: message.is_error === true,
      terminalReason: safeLabel(message.terminal_reason),
      apiErrorStatus: safeNumber(message.api_error_status),
      durationMs: safeNumber(message.duration_ms),
      durationApiMs: safeNumber(message.duration_api_ms),
      numTurns: safeNumber(message.num_turns),
      inputTokens: safeNumber(usage.input_tokens),
      outputTokens: safeNumber(usage.output_tokens),
      modelUsageCount: Object.keys(modelUsage).length,
      permissionDenialCount: arrayLength(message.permission_denials),
      errorCount: arrayLength(message.errors),
    };
  }

  if (message.type === 'assistant') {
    const assistantMessage = isRecord(message.message) ? message.message : {};
    const usage = isRecord(assistantMessage.usage) ? assistantMessage.usage : {};
    return {
      type: 'assistant',
      model: safeLabel(assistantMessage.model),
      stopReason: safeProtocolLabel(assistantMessage.stop_reason),
      error: safeProtocolLabel(message.error),
      aborted: message.aborted === true,
      contentBlockCount: arrayLength(assistantMessage.content),
      inputTokens: safeNumber(usage.input_tokens),
      outputTokens: safeNumber(usage.output_tokens),
    };
  }

  if (message.type === 'user') {
    const userMessage = isRecord(message.message) ? message.message : {};
    const origin = isRecord(message.origin) ? message.origin : {};
    return {
      type: 'user',
      isSynthetic: message.isSynthetic === true,
      shouldQuery: message.shouldQuery !== false,
      priority: safeProtocolLabel(message.priority),
      originKind: safeProtocolLabel(origin.kind),
      contentBlockCount: arrayLength(userMessage.content),
      hasToolUseResult: message.tool_use_result !== undefined,
    };
  }

  if (message.type === 'rate_limit_event') {
    const rateLimitInfo = isRecord(message.rate_limit_info) ? message.rate_limit_info : {};
    return {
      type: 'rate_limit_event',
      status: safeProtocolLabel(rateLimitInfo.status),
      rateLimitType: safeProtocolLabel(rateLimitInfo.rateLimitType),
      utilization: safeNumber(rateLimitInfo.utilization),
      isUsingOverage: rateLimitInfo.isUsingOverage === true,
    };
  }

  return {
    type: safeProtocolLabel(message.type) ?? 'unknown',
    subtype: safeProtocolLabel(message.subtype),
  };
}
