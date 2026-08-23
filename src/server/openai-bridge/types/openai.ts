// OpenAI Chat Completions API types (subset used by bridge)

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
  prompt_cache_key?: string;
  prompt_cache_retention?: 'in_memory' | '24h';
  // #324: plain string — provider vocabularies diverge (OpenAI adds
  // none/minimal/xhigh, Volcano Ark adds max, DeepSeek maps silently);
  // values pass through verbatim, acceptance is the upstream's contract.
  reasoning_effort?: string;
}

export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

export interface OpenAISystemMessage {
  role: 'system';
  content: string | OpenAITextContentPart[];
}

export interface OpenAIUserMessage {
  role: 'user';
  content: string | OpenAIContentPart[];
}

export interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | OpenAITextContentPart[] | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string | OpenAITextContentPart[];
}

export type OpenAIContentPart =
  | OpenAITextContentPart
  | { type: 'image_url'; image_url: { url: string; detail?: string }; prompt_cache_breakpoint?: OpenAIPromptCacheBreakpoint };

export type OpenAITextContentPart = {
  type: 'text';
  text: string;
  prompt_cache_breakpoint?: OpenAIPromptCacheBreakpoint;
};

export type OpenAIPromptCacheBreakpoint = { mode: 'explicit' };

/** Gemini extension: thought_signature nested in extra_content for OpenAI-compatible format */
export interface GeminiExtraContent {
  google?: { thought_signature?: string };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  /** Gemini thinking models require round-tripping this field on tool calls (direct field) */
  thought_signature?: string;
  /** Gemini OpenAI-compat format: thought_signature at extra_content.google.thought_signature */
  extra_content?: GeminiExtraContent;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

// Response types

export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

export interface OpenAIChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: OpenAIFinishReason | null;
}

export type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

// Streaming types

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: OpenAIUsage | null;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: OpenAIFinishReason | null;
}

export interface OpenAIStreamDelta {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIStreamToolCall[];
}

export interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
  /** Gemini thinking models include this on tool call chunks (direct field) */
  thought_signature?: string;
  /** Gemini OpenAI-compat format: thought_signature at extra_content.google.thought_signature */
  extra_content?: GeminiExtraContent;
}
