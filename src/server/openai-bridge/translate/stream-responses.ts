// ResponsesStreamTranslator: OpenAI Responses API SSE → Anthropic SSE events (state machine)

import type { AnthropicStreamEvent, AnthropicResponse } from '../types/anthropic';
import type { ResponsesStreamEvent, ResponsesUsage } from '../types/openai-responses';
import { generateMessageId, generateToolUseId } from '../utils/id';
import {
  emptyUsage,
  fromResponsesUsage,
  toAnthropicUsage,
  type UsageSnapshot,
  type UsageWarningLogger,
} from './usage';

interface FunctionCallBuffer {
  callId: string;
  name: string;
  args: string;
  anthropicIndex: number;
}

export class ResponsesStreamTranslator {
  private messageId: string;
  private requestModel: string;
  private contentIndex = 0;
  private activeBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
  private hasEmittedStart = false;
  private hasFinished = false;
  private usage: UsageSnapshot = emptyUsage();
  private usageWarning: UsageWarningLogger | undefined;

  // Track function calls by output_index
  private functionCallBuffers = new Map<number, FunctionCallBuffer>();
  // Track reasoning block
  private hasActiveReasoning = false;

  constructor(requestModel: string, usageWarning?: UsageWarningLogger) {
    this.messageId = generateMessageId();
    this.requestModel = requestModel;
    let warned = false;
    this.usageWarning = usageWarning
      ? (message) => {
          if (warned) return;
          warned = true;
          usageWarning(message);
        }
      : undefined;
  }

  /** Feed a Responses API SSE event, returns Anthropic SSE events to emit */
  feed(event: ResponsesStreamEvent): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];

    // Emit message_start on first event
    if (!this.hasEmittedStart) {
      this.hasEmittedStart = true;
      events.push(this.makeMessageStart());
    }

    switch (event.type) {
      case 'response.output_text.delta':
        this.handleTextDelta(event.delta, events);
        break;

      case 'response.output_text.done':
        this.closeActiveBlock(events);
        break;

      case 'response.function_call_arguments.delta':
        this.handleFunctionCallDelta(event.output_index, event.delta, events);
        break;

      case 'response.function_call_arguments.done':
        this.closeFunctionCallBlock(event.output_index, events);
        break;

      case 'response.output_item.added':
        if (event.item.type === 'function_call') {
          this.closeActiveBlock(events);
          this.activeBlockType = 'tool_use';

          const callId = event.item.call_id || generateToolUseId();
          const name = event.item.name || '';
          const anthropicIndex = this.contentIndex;

          this.functionCallBuffers.set(event.output_index, {
            callId,
            name,
            args: '',
            anthropicIndex,
          });

          events.push({
            type: 'content_block_start',
            index: anthropicIndex,
            content_block: { type: 'tool_use', id: callId, name, input: {} },
          });
        }
        break;

      case 'response.reasoning_summary_text.delta':
        this.handleReasoningDelta(event.delta, events);
        break;

      case 'response.reasoning_summary_text.done':
        if (this.hasActiveReasoning) {
          this.closeActiveBlock(events);
          this.hasActiveReasoning = false;
        }
        break;

      case 'response.completed':
        this.handleCompleted(event.response, events);
        break;

      case 'response.failed':
        this.handleFailed(event.response, events);
        break;

      // Other events are no-ops for Anthropic translation
      default:
        break;
    }

    return events;
  }

  private handleTextDelta(delta: string, events: AnthropicStreamEvent[]): void {
    if (this.activeBlockType !== 'text') {
      this.closeActiveBlock(events);
      this.activeBlockType = 'text';
      events.push({
        type: 'content_block_start',
        index: this.contentIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    events.push({
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: { type: 'text_delta', text: delta },
    });
  }

  private handleReasoningDelta(delta: string, events: AnthropicStreamEvent[]): void {
    if (this.activeBlockType !== 'thinking') {
      this.closeActiveBlock(events);
      this.activeBlockType = 'thinking';
      this.hasActiveReasoning = true;
      events.push({
        type: 'content_block_start',
        index: this.contentIndex,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
    }
    events.push({
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: { type: 'thinking_delta', thinking: delta },
    });
  }

  private handleFunctionCallDelta(
    outputIndex: number,
    delta: string,
    events: AnthropicStreamEvent[],
  ): void {
    let buffer = this.functionCallBuffers.get(outputIndex);

    if (!buffer) {
      // Function call started without output_item.added (shouldn't happen, but handle gracefully)
      this.closeActiveBlock(events);
      this.activeBlockType = 'tool_use';

      const callId = generateToolUseId();
      const anthropicIndex = this.contentIndex;
      buffer = { callId, name: '', args: '', anthropicIndex };
      this.functionCallBuffers.set(outputIndex, buffer);

      events.push({
        type: 'content_block_start',
        index: anthropicIndex,
        content_block: { type: 'tool_use', id: callId, name: '', input: {} },
      });
    }

    buffer.args += delta;
    events.push({
      type: 'content_block_delta',
      index: buffer.anthropicIndex,
      delta: { type: 'input_json_delta', partial_json: delta },
    });
  }

  private handleFailed(
    response: { usage?: ResponsesUsage; status: string; error?: { code: string; message: string } | null },
    events: AnthropicStreamEvent[],
  ): void {
    this.closeActiveBlock(events);

    // Emit error message as a text block so the SDK sees the failure reason
    const errMsg = response.error?.message ?? 'Unknown upstream error';
    events.push({
      type: 'content_block_start',
      index: this.contentIndex,
      content_block: { type: 'text', text: '' },
    });
    events.push({
      type: 'content_block_delta',
      index: this.contentIndex,
      delta: { type: 'text_delta', text: `[Error]: ${errMsg}` },
    });
    events.push({ type: 'content_block_stop', index: this.contentIndex });
    this.contentIndex++;

    this.hasFinished = true;

    if (response.usage) {
      this.usage = fromResponsesUsage(response.usage, this.usageWarning);
    }

    events.push({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: toAnthropicUsage(this.usage),
    });
    events.push({ type: 'message_stop' });
  }

  /** Close a function call block by output_index (not global activeBlockType) */
  private closeFunctionCallBlock(outputIndex: number, events: AnthropicStreamEvent[]): void {
    const buffer = this.functionCallBuffers.get(outputIndex);
    if (buffer) {
      events.push({ type: 'content_block_stop', index: buffer.anthropicIndex });
      // Advance contentIndex if this buffer's block is the current one
      if (buffer.anthropicIndex === this.contentIndex) {
        this.contentIndex++;
      }
      if (this.activeBlockType === 'tool_use') {
        this.activeBlockType = null;
      }
    } else {
      // Fallback: close whatever is active
      this.closeActiveBlock(events);
    }
  }

  private handleCompleted(response: { usage?: ResponsesUsage; status: string }, events: AnthropicStreamEvent[]): void {
    this.closeActiveBlock(events);
    this.hasFinished = true;

    // Extract usage
    if (response.usage) {
      this.usage = fromResponsesUsage(response.usage, this.usageWarning);
    }

    // Determine stop reason
    const hasToolUse = this.functionCallBuffers.size > 0;
    const stopReason = hasToolUse ? 'tool_use' as const
      : response.status === 'incomplete' ? 'max_tokens' as const
      : 'end_turn' as const;

    events.push({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: toAnthropicUsage(this.usage),
    });
    events.push({ type: 'message_stop' });
  }

  /** Finalize — emit closing events for incomplete streams */
  finalize(): AnthropicStreamEvent[] {
    if (this.hasFinished || !this.hasEmittedStart) return [];

    const events: AnthropicStreamEvent[] = [];
    this.closeActiveBlock(events);
    this.hasFinished = true;

    events.push({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: toAnthropicUsage(this.usage),
    });
    events.push({ type: 'message_stop' });
    return events;
  }

  private closeActiveBlock(events: AnthropicStreamEvent[]): void {
    if (this.activeBlockType !== null) {
      events.push({ type: 'content_block_stop', index: this.contentIndex });
      this.contentIndex++;
      this.activeBlockType = null;
    }
  }

  private makeMessageStart(): AnthropicStreamEvent {
    const message: AnthropicResponse = {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: this.requestModel,
      stop_reason: null,
      stop_sequence: null,
      usage: toAnthropicUsage(this.usage),
    };
    return { type: 'message_start', message };
  }
}
