// Anthropic Messages API types (subset used by bridge)

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
  metadata?: Record<string, unknown>;
}

export type AnthropicCacheControl = {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
};

export type AnthropicSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl | null;
};

export type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock;

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl | null;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
  cache_control?: AnthropicCacheControl | null;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AnthropicCacheControl | null;
  // Note: thought_signature is intentionally NOT included here.
  // It's a Gemini-specific field that lives only on the OpenAI side (handler.ts cache).
  // Including it in Anthropic-format blocks pollutes the SDK transcript → API rejection. See: #68
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicToolResultContent[];
  is_error?: boolean;
  cache_control?: AnthropicCacheControl | null;
}

export type AnthropicToolResultContent = {
  type: 'text';
  text: string;
} | {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl | null;
}

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'none' }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

// Response types

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicResponseContentBlock[];
  model: string;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export type AnthropicResponseContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; thinking: string; signature: string };

export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// SSE event types

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicResponse }
  | { type: 'content_block_start'; index: number; content_block: AnthropicResponseContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicStreamDelta }
  | { type: 'content_block_stop'; index: number }
  // usage carries the FULL accumulated usage (input + output + cache), not just
  // output_tokens. The Anthropic SDK reads input_tokens / cache_*_input_tokens
  // from message_delta.usage when present (MessageStream.accumulateMessage), so
  // the bridge must report them here to surface non-zero usage. See issue #277.
  | { type: 'message_delta'; delta: { stop_reason: AnthropicStopReason | null; stop_sequence: string | null }; usage: AnthropicUsage }
  | { type: 'message_stop' }
  | { type: 'ping' };

export type AnthropicStreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string };

export interface AnthropicErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}
