// Non-streaming response translation: OpenAI Responses API → Anthropic

import type { AnthropicResponse, AnthropicResponseContentBlock, AnthropicStopReason } from '../types/anthropic';
import type { ResponsesResponse, ResponsesOutputItem } from '../types/openai-responses';
import { generateMessageId } from '../utils/id';
import { fromResponsesUsage, toAnthropicUsage, type UsageWarningLogger } from './usage';
import { safeParseJson } from './tools';

/** Map Responses API status → Anthropic stop_reason */
function translateResponsesStatus(status: string): AnthropicStopReason {
  switch (status) {
    case 'completed': return 'end_turn';
    case 'incomplete': return 'max_tokens';
    default: return 'end_turn';
  }
}

/** Translate OpenAI Responses API response → Anthropic response.
 *  Throws on `status: 'failed'` to surface upstream error. */
export function translateResponsesResponse(
  resp: ResponsesResponse,
  requestModel: string,
  usageWarning?: UsageWarningLogger,
): AnthropicResponse {
  // Surface upstream failure as a thrown error so handler returns 502
  if (resp.status === 'failed') {
    const errMsg = resp.error?.message ?? 'Unknown upstream error';
    const errCode = resp.error?.code ?? 'api_error';
    throw new ResponsesApiError(errCode, errMsg);
  }

  const content: AnthropicResponseContentBlock[] = [];
  let hasToolUse = false;

  for (const item of resp.output) {
    translateOutputItem(item, content);
    if (item.type === 'function_call') hasToolUse = true;
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // Build usage
  const usage = fromResponsesUsage(resp.usage, usageWarning);

  // Determine stop reason
  let stopReason: AnthropicStopReason;
  if (hasToolUse) {
    stopReason = 'tool_use';
  } else {
    stopReason = translateResponsesStatus(resp.status);
  }

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: toAnthropicUsage(usage),
  };
}

/** Error thrown when Responses API returns status: 'failed' */
export class ResponsesApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ResponsesApiError';
  }
}

function translateOutputItem(item: ResponsesOutputItem, content: AnthropicResponseContentBlock[]): void {
  switch (item.type) {
    case 'message':
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'refusal') {
          content.push({ type: 'text', text: `[Refusal]: ${part.refusal}` });
        }
      }
      break;

    case 'function_call':
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: safeParseJson(item.arguments),
      });
      break;

    case 'reasoning':
      if (item.summary && item.summary.length > 0) {
        const thinkingText = item.summary
          .map(s => s.text)
          .filter(Boolean)
          .join('\n');
        if (thinkingText) {
          content.push({
            type: 'thinking',
            thinking: thinkingText,
            signature: '',
          });
        }
      }
      break;
  }
}
