// Non-streaming response translation: OpenAI → Anthropic

import type {
  AnthropicResponse,
  AnthropicResponseContentBlock,
  AnthropicStopReason,
} from "../types/anthropic";
import type { OpenAIResponse, OpenAIToolCall } from "../types/openai";
import { translateToolCalls } from "./tools";
import { generateMessageId } from "../utils/id";
import { fromOpenAIUsage, toAnthropicUsage } from "./usage";
import {
  DSML_PARSE_ERROR_TEXT,
  excludeEquivalentToolCalls,
  parseDsmlToolCalls,
} from "./dsml";

/** Map OpenAI finish_reason → Anthropic stop_reason */
export function translateStopReason(
  reason: string | null,
): AnthropicStopReason | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return reason ? "end_turn" : null;
  }
}

/** Translate OpenAI response → Anthropic response */
export function translateResponse(
  openaiResp: OpenAIResponse,
  requestModel: string,
  translateReasoning = true,
  usageWarning?: UsageWarningLogger,
): AnthropicResponse {
  const choice = openaiResp.choices?.[0];
  const content: AnthropicResponseContentBlock[] = [];
  let hasToolCalls = false;
  let hasMalformedDsml = false;

  if (choice) {
    // reasoning_content → thinking block (if enabled)
    if (translateReasoning) {
      const reasoning = (choice.message as { reasoning_content?: string })
        .reasoning_content;
      if (reasoning) {
        content.push({
          type: "thinking",
          thinking: reasoning,
          signature: "",
        });
      }
    }

    const standardToolCalls = choice.message.tool_calls ?? [];
    let dsmlToolCalls: OpenAIToolCall[] = [];
    if (choice.message.content) {
      const dsml = parseDsmlToolCalls(choice.message.content);
      if (dsml.kind === "parsed") {
        dsmlToolCalls = excludeEquivalentToolCalls(
          dsml.toolCalls,
          standardToolCalls,
        );
      } else if (dsml.kind === "malformed") {
        console.warn("[bridge] Failed to parse DSML tool calls:", dsml.error);
        content.push({ type: "text", text: DSML_PARSE_ERROR_TEXT });
        hasMalformedDsml = true;
      } else {
        content.push({ type: "text", text: choice.message.content });
      }
    }
    const toolCalls = [...standardToolCalls, ...dsmlToolCalls];
    if (toolCalls.length > 0) {
      content.push(...translateToolCalls(toolCalls));
      hasToolCalls = true;
    }
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const usage = fromOpenAIUsage(openaiResp.usage, usageWarning);

  return {
    id: generateMessageId(),
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: hasToolCalls
      ? "tool_use"
      : hasMalformedDsml
        ? "end_turn"
        : translateStopReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: toAnthropicUsage(usage),
  };
}
