// OpenAI Responses API types (subset used by bridge)

// ==================== Request ====================

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  max_output_tokens?: number;
  prompt_cache_key?: string;
  prompt_cache_retention?: '24h' | 'in_memory';
  previous_response_id?: string;
  store?: boolean;
  conversation?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  // #324: effort widened to plain string — same pass-through rationale as
  // OpenAIRequest.reasoning_effort (provider vocabularies diverge).
  reasoning?: { effort: string };
  text?: { format: ResponsesTextFormat };
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesInputFunctionCall
  | ResponsesInputFunctionCallOutput;

export interface ResponsesInputMessage {
  role: 'system' | 'user' | 'assistant' | 'developer';
  content: string | ResponsesInputContentPart[];
}

/** Replay of a prior assistant function call in conversation history */
export interface ResponsesInputFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
}

export type ResponsesInputContentPart =
  | { type: 'input_text'; text: string; prompt_cache_breakpoint?: ResponsesPromptCacheBreakpoint }
  | { type: 'input_image'; image_url: string; detail?: string; prompt_cache_breakpoint?: ResponsesPromptCacheBreakpoint }
  | { type: 'output_text'; text: string }
  | { type: 'refusal'; refusal: string };

export type ResponsesPromptCacheBreakpoint = { mode: 'explicit' };

export interface ResponsesInputFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export type ResponsesToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; name: string };

export type ResponsesTextFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };

// ==================== Response ====================

export interface ResponsesResponse {
  id: string;
  object: 'response';
  status: 'completed' | 'failed' | 'in_progress' | 'incomplete';
  output: ResponsesOutputItem[];
  usage: ResponsesUsage;
  model: string;
  error?: { code: string; message: string } | null;
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning;

export interface ResponsesOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  status: string;
  content: ResponsesOutputContent[];
}

export type ResponsesOutputContent =
  | { type: 'output_text'; text: string }
  | { type: 'refusal'; refusal: string };

export interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

export interface ResponsesOutputReasoning {
  type: 'reasoning';
  id: string;
  summary: { type: 'summary_text'; text: string }[];
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

// ==================== Streaming Events ====================

export type ResponsesStreamEvent =
  | { type: 'response.created'; response: ResponsesResponse }
  | { type: 'response.in_progress'; response: ResponsesResponse }
  | { type: 'response.completed'; response: ResponsesResponse }
  | { type: 'response.failed'; response: ResponsesResponse }
  | { type: 'response.output_item.added'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.content_part.added'; output_index: number; content_index: number; part: ResponsesOutputContent }
  | { type: 'response.content_part.done'; output_index: number; content_index: number; part: ResponsesOutputContent }
  | { type: 'response.output_text.delta'; output_index: number; content_index: number; delta: string }
  | { type: 'response.output_text.done'; output_index: number; content_index: number; text: string }
  | { type: 'response.function_call_arguments.delta'; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; output_index: number; arguments: string }
  | { type: 'response.reasoning_summary_text.delta'; output_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.done'; output_index: number; text: string };
