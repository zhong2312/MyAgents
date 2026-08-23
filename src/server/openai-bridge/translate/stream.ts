// StreamTranslator: OpenAI stream chunks → Anthropic SSE events (state machine)

import type {
  AnthropicStreamEvent,
  AnthropicResponse,
  AnthropicStopReason,
} from "../types/anthropic";
import type {
  OpenAIStreamChunk,
  OpenAIStreamToolCall,
  OpenAIToolCall,
} from "../types/openai";
import { translateStopReason } from "./response";
import { generateMessageId, generateToolUseId } from "../utils/id";
import {
  emptyUsage,
  mergeUsage,
  toAnthropicUsage,
  type UsageSnapshot,
} from "./usage";
import {
  DSML_PARSE_ERROR_TEXT,
  excludeEquivalentToolCalls,
  isDsmlToolCallsStart,
  isPossibleDsmlToolCallsStart,
  parseDsmlToolCalls,
} from "./dsml";

interface ToolCallBuffer {
  id: string;
  name: string;
  args: string;
}

export class StreamTranslator {
  private messageId: string;
  private requestModel: string;
  private contentIndex = 0;
  private activeBlockType: "text" | "thinking" | "tool_use" | null = null;
  private toolCallBuffers = new Map<number, ToolCallBuffer>();
  private usage: UsageSnapshot = emptyUsage();
  private hasEmittedStart = false;
  private hasFinished = false;
  private stopReason: AnthropicStopReason | null = null;
  private translateReasoning: boolean;
  private contentMode: "pending" | "text" | "dsml" = "pending";
  private bufferedContent = "";
  private hasStandardToolCalls = false;

  constructor(requestModel: string, translateReasoning = true, usageWarning?: UsageWarningLogger) {
    this.messageId = generateMessageId();
    this.requestModel = requestModel;
    this.translateReasoning = translateReasoning;
    let warned = false;
    this.usageWarning = usageWarning
      ? (message) => {
          if (warned) return;
          warned = true;
          usageWarning(message);
        }
      : undefined;
  }

  /** Feed an OpenAI stream chunk, returns Anthropic SSE events to emit */
  feed(chunk: OpenAIStreamChunk): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];

    // Emit message_start on first chunk
    if (!this.hasEmittedStart) {
      this.hasEmittedStart = true;
      events.push(this.makeMessageStart());
    }

    // Track usage
    if (chunk.usage) {
      this.usage = mergeUsage(this.usage, chunk.usage, this.usageWarning);
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      // Usage-only chunk (final chunk with no choices)
      return events;
    }

    const delta = choice.delta;

    // Handle reasoning_content (thinking)
    if (this.translateReasoning && delta.reasoning_content) {
      if (this.activeBlockType !== "thinking") {
        this.closeActiveBlock(events);
        this.activeBlockType = "thinking";
        events.push({
          type: "content_block_start",
          index: this.contentIndex,
          content_block: { type: "thinking", thinking: "", signature: "" },
        });
      }
      events.push({
        type: "content_block_delta",
        index: this.contentIndex,
        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
      });
    }

    // Handle text content
    if (delta.content) {
      this.handleContentDelta(delta.content, events);
    }

    // Handle tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        this.handleToolCallDelta(tc, events);
      }
    }

    // Handle finish.
    // Per the OpenAI spec, with stream_options.include_usage=true the `usage`
    // payload arrives in a SEPARATE trailing chunk (empty `choices`) AFTER this
    // finish_reason chunk. Emitting the terminal message_delta/message_stop here
    // would pin token counts to whatever was known so far (0) — the trailing
    // usage chunk would then be dropped (it returns early above on `!choice`).
    // So we close the active block + record the stop_reason now, but defer the
    // terminal events to finalize() (emitted on stream end / flush), by which
    // point `this.usage` has accumulated the trailing usage chunk. See issue #277.
    if (choice.finish_reason) {
      this.closeActiveBlock(events);
      this.stopReason = translateStopReason(choice.finish_reason);
    }

    return events;
  }

  private handleToolCallDelta(
    tc: OpenAIStreamToolCall,
    events: AnthropicStreamEvent[],
  ): void {
    this.hasStandardToolCalls = true;
    const idx = tc.index;

    if (!this.toolCallBuffers.has(idx)) {
      // New tool call — close previous block, start new tool_use
      this.closeActiveBlock(events);
      this.activeBlockType = "tool_use";

      const id = tc.id || generateToolUseId();
      const name = tc.function?.name || "";
      this.toolCallBuffers.set(idx, { id, name, args: "" });

      // IMPORTANT: thought_signature is intentionally NOT included on content_block_start.
      // The SDK stores these events in its session transcript and replays them on resume.
      // Including non-standard fields causes API rejection ("Extra inputs are not permitted").
      // The bridge handler caches thought_signatures separately. See: #68
      events.push({
        type: "content_block_start",
        index: this.contentIndex,
        content_block: { type: "tool_use", id, name, input: {} },
      });
    }

    // Accumulate arguments
    const buffer = this.toolCallBuffers.get(idx)!;
    if (tc.function?.arguments) {
      buffer.args += tc.function.arguments;
      events.push({
        type: "content_block_delta",
        index: this.contentIndex,
        delta: {
          type: "input_json_delta",
          partial_json: tc.function.arguments,
        },
      });
    }
  }

  /**
   * Finalize the stream — emit the terminal message_delta + message_stop.
   * Invoked by the handler on the `[DONE]` protocol terminator (preferred) or on
   * stream flush / transport end (fallback for streams that close without one).
   * This is the SOLE emitter of terminal events: feed() defers them here so the
   * full usage (including the trailing usage-only chunk) is reported. Carries the
   * stop_reason captured from finish_reason (defaults to 'end_turn' for streams
   * that ended without one). No-op if already finalized or never started.
   */
  finalize(): AnthropicStreamEvent[] {
    if (this.hasFinished || !this.hasEmittedStart) return [];

    const events: AnthropicStreamEvent[] = [];
    this.flushBufferedContent(events);
    this.closeActiveBlock(events);
    this.hasFinished = true;

    events.push({
      type: "message_delta",
      delta: {
        stop_reason: this.stopReason ?? "end_turn",
        stop_sequence: null,
      },
      usage: toAnthropicUsage(this.usage),
    });
    events.push({ type: "message_stop" });
    return events;
  }

  private closeActiveBlock(events: AnthropicStreamEvent[]): void {
    if (this.activeBlockType !== null) {
      events.push({ type: "content_block_stop", index: this.contentIndex });
      this.contentIndex++;
      this.activeBlockType = null;
    }
  }

  private handleContentDelta(
    text: string,
    events: AnthropicStreamEvent[],
  ): void {
    const incomingCandidate = text.trimStart();
    if (this.contentMode !== "dsml") {
      if (isPossibleDsmlToolCallsStart(incomingCandidate)) {
        this.bufferedContent = text;
        this.contentMode = "dsml";
        return;
      }
      if (this.contentMode === "pending" && this.bufferedContent) {
        const buffered = this.bufferedContent + text;
        this.bufferedContent = "";
        this.contentMode = "text";
        this.emitTextDelta(buffered, events);
        return;
      }
      this.contentMode = "text";
      this.emitTextDelta(text, events);
      return;
    }

    const bufferedCandidate = this.bufferedContent.trimStart();
    if (isDsmlToolCallsStart(incomingCandidate)) {
      // Some OpenAI-compatible providers stream the complete accumulated DSML
      // snapshot in every delta instead of emitting only the new suffix. Keep
      // the newest/longest snapshot; concatenating them corrupts the protocol
      // into recursively repeated tool_calls blocks.
      if (
        !isDsmlToolCallsStart(bufferedCandidate) ||
        incomingCandidate.length >= bufferedCandidate.length
      ) {
        this.bufferedContent = text;
      }
    } else {
      this.bufferedContent += text;
    }
  }

  private emitTextDelta(text: string, events: AnthropicStreamEvent[]): void {
    if (!text) return;
    if (this.activeBlockType !== "text") {
      this.closeActiveBlock(events);
      this.activeBlockType = "text";
      events.push({
        type: "content_block_start",
        index: this.contentIndex,
        content_block: { type: "text", text: "" },
      });
    }
    events.push({
      type: "content_block_delta",
      index: this.contentIndex,
      delta: { type: "text_delta", text },
    });
  }

  private flushBufferedContent(events: AnthropicStreamEvent[]): void {
    if (!this.bufferedContent) return;
    const buffered = this.bufferedContent;
    this.bufferedContent = "";
    this.contentMode = "text";

    const parsed = parseDsmlToolCalls(buffered);
    if (parsed.kind === "not-dsml") {
      this.emitTextDelta(buffered, events);
      return;
    }
    if (parsed.kind === "malformed") {
      console.warn(
        "[bridge] Failed to parse streamed DSML tool calls:",
        parsed.error,
      );
      this.emitTextDelta(DSML_PARSE_ERROR_TEXT, events);
      if (!this.hasStandardToolCalls) this.stopReason = "end_turn";
      return;
    }
    const standardToolCalls: OpenAIToolCall[] = [
      ...this.toolCallBuffers.values(),
    ].map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.args },
    }));
    const dsmlToolCalls = excludeEquivalentToolCalls(
      parsed.toolCalls,
      standardToolCalls,
    );
    for (const toolCall of dsmlToolCalls) {
      this.closeActiveBlock(events);
      this.activeBlockType = "tool_use";
      const id = toolCall.id || generateToolUseId();
      events.push({
        type: "content_block_start",
        index: this.contentIndex,
        content_block: {
          type: "tool_use",
          id,
          name: toolCall.function.name,
          input: {},
        },
      });
      events.push({
        type: "content_block_delta",
        index: this.contentIndex,
        delta: {
          type: "input_json_delta",
          partial_json: toolCall.function.arguments,
        },
      });
      this.closeActiveBlock(events);
    }
    if (dsmlToolCalls.length > 0 || this.hasStandardToolCalls) {
      this.stopReason = "tool_use";
    }
  }

  private makeMessageStart(): AnthropicStreamEvent {
    const message: AnthropicResponse = {
      id: this.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: this.requestModel,
      stop_reason: null,
      stop_sequence: null,
      usage: toAnthropicUsage(this.usage),
    };
    return { type: "message_start", message };
  }
}
