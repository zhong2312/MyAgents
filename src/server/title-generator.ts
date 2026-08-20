/**
 * title-generator.ts — AI-powered session title generation.
 *
 * Runtime-aware:
 *   - workbench tool-free one-shot → in-process direct provider HTTP
 *   - builtin/title generation → Claude Agent SDK query() with provider-env
 *   - external → spawns a fresh short-lived process of the session's runtime
 *                (claude-code / codex / gemini) with the title system prompt.
 *                Model, CLI auth, etc. are inherited from the active runtime
 *                so Gemini/Codex sessions no longer fall back to Anthropic SDK.
 *
 * Always single-turn; never persists the title session. Timing: the backend
 * Title Service triggers this after AUTO_TITLE_MIN_ROUNDS (2) completed QA rounds;
 * before that the session shows the default truncated-first-message title.
 */

import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  resolveClaudeCodeCli,
  buildClaudeSessionEnv,
  startOneShotBridge,
} from "./agent-session";
import type { ProviderEnv } from "./provider-types";
import {
  applyContextWindowSuffixForContextLength,
  applyProviderContextWindowSuffix,
} from "./utils/model-capabilities";
import { SUBSCRIPTION_PROVIDER_ID } from "../shared/config-types";
import { isLikelyErrorTitle } from "../shared/titleFilters";
import { capTitleAtBoundary } from "../shared/sessionTitle";
import { ClaudeCodeRuntime } from "./runtimes/claude-code";
import { CodexRuntime } from "./runtimes/codex";
import { GeminiRuntime } from "./runtimes/gemini";
import type {
  AgentRuntime,
  RuntimeProcess,
  SessionStartOptions,
} from "./runtimes/types";
import type { RuntimeSource, RuntimeType } from "../shared/types/runtime";
import { ensureDirSync } from "./utils/fs-utils";
import { createGuardedSdkQuery } from "./utils/sdk-child-launch-guard";
import type {
  WorkbenchAgentToolsetRequest,
  WorkbenchAiRunProgressKind,
} from "../shared/workbench-sdk";

const TITLE_MAX_LENGTH = 30;
export const BUILTIN_TITLE_TIMEOUT_MS = 30_000;
/** External runtimes (Gemini/Codex/CC) have higher cold-start cost — node/CLI
 *  spawn + ACP/JSON-RPC handshake + potential OAuth refresh. Gemini alone can
 *  take ~10s to first token. 30s keeps headroom without stalling the UI. */
const EXTERNAL_TIMEOUT_MS = 30_000;
/** Max chars per user/assistant message when building context */
const PER_MESSAGE_LIMIT = 200;

/**
 * Security (review #2): the title turn must NOT be able to run any tool — its
 * sole input is (indirect-injection-prone) transcript text. Claude Code is the
 * one external runtime that honours `--disallowed-tools` (claude-code.ts:382),
 * so we strip the full built-in surface there. Codex/Gemini don't consume this
 * list, so they're constrained via a read-only / approval-required permission
 * mode instead (see `titlePermissionMode`). Listing every built-in name (rather
 * than relying on permission mode) removes the tools from the model's context
 * entirely, so even bypassPermissions has nothing to auto-execute. */
const TITLE_GEN_DISALLOWED_TOOLS = [
  "Task",
  "Bash",
  "BashOutput",
  "KillShell",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "SlashCommand",
  "ExitPlanMode",
  "AskUserQuestion",
];

const SYSTEM_PROMPT = `You are a session title generator for a chat app. Weeks later the user will
scan a long list of past sessions — your title must let them INSTANTLY
recognize which task this was, and tell it apart from similar ones.

A good title is a RETRIEVAL CUE, not a summary. Optimize for: seeing only this
title in a list, would the user think "oh, that's the time I did X"?

MUST keep — preserve the most distinctive anchor from the conversation,
verbatim, whenever one exists:
  - proper noun / project / product name  (高考, 知乎2077, MyAgents, 望京北路)
  - issue / PR / version number           (#215, #223, 0.2.22)
  - specific file, API, library, error code (教宗通谕.docx, SSE, Cron, 402)
These exact strings are what make the session findable — keeping them matters
MORE than avoiding repetition or sounding clean.

A common effective shape is [domain/project] + [specific sub-task/artifact] +
[action], e.g. 高考题号展示调整. This is GUIDANCE, not a template — use whatever
phrasing is most recognizable for this particular conversation.

Rules:
  - Identify the real task across ALL rounds, not just round 1 — openers are
    often vague (回忆一下…, yo, 速度快不快).
  - Match the dominant language of the user's messages.
  - Short by default — a few words. Hard limit 30 characters (CJK counts as 1).
    If it doesn't fit, drop the least distinctive words, never the anchor.
  - NEVER use a full sentence, the user's whole request, or the assistant's
    reply/greeting as the title.
  - NEVER use generic fillers (帮助/问题/讨论/请求 · help/question/discussion)
    or meta-text about the title itself (对话标题应该是…, The title should be…).
  - If there is no real task yet (pure greeting / one-liner / test), output a
    short neutral label such as 新对话 — do NOT invent a topic.

Output ONLY the title. No quotes, no surrounding punctuation, no explanation.

Examples:
  tweak how exam question numbers render on a page   → 高考题号展示调整
  transcribe a recorded .m4a conversation            → 望京北路音频转写
  investigate issue #215 about Ctrl+F search nav     → #215 搜索导航 Bug 调研
  merge and release the 0.2.22 branch                → 0.2.22 合并发布
  conversation is just 你好 / 测试                     → 新对话`;

export interface TitleRound {
  user: string;
  assistant: string;
}

function buildUserPrompt(rounds: TitleRound[]): string {
  const parts = rounds.map((r, i) => {
    const user = r.user.slice(0, PER_MESSAGE_LIMIT);
    const assistant = r.assistant.slice(0, PER_MESSAGE_LIMIT);
    return `[Round ${i + 1}]\nUser: ${user}\nAssistant: ${assistant}`;
  });
  // Restate the hard constraints at the very END (recency): weaker / smaller
  // title-gen models follow the last instruction most reliably.
  return `<conversation>\n${parts.join("\n\n")}\n</conversation>\n\nWrite the session title. Keep the most distinctive anchor (name / number / file), match the user's language, ≤30 chars, output only the title.`;
}

/**
 * Clean up the generated title: remove surrounding quotes, punctuation, whitespace,
 * and truncate to TITLE_MAX_LENGTH characters.
 */
function cleanTitle(raw: string): string {
  let cleaned = raw.trim();
  // Remove surrounding quotes (single, double, Chinese quotes)
  cleaned = cleaned.replace(/^["'「『《【"']+|["'」』》】"']+$/g, "");
  // Remove trailing punctuation
  cleaned = cleaned.replace(/[。，、；：！？.,:;!?…]+$/, "");
  // Remove common AI preamble patterns
  cleaned = cleaned.replace(/^(标题[：:]|Title[：:])\s*/i, "");
  // Defense-in-depth: strip angle brackets so a model-injected "<script>" never reaches
  // a consumer that might render titles as HTML/Markdown raw. Frontend uses text nodes
  // today, but title is long-lived metadata and cheap to harden here.
  cleaned = cleaned.replace(/[<>]/g, "");
  cleaned = cleaned.trim();
  // #245 backstop: if the title looks like an upstream-error string (SDK 4xx/5xx
  // surface, openai-bridge [Error]: …) the title-gen LLM has either echoed
  // garbage input verbatim or the title-gen call itself failed and surfaced the
  // error. Reject so the caller treats it as "no title" and the frontend falls
  // back to its truncated-first-message default. Primary gate is the renderer
  // shouldRecordTurnForTitle; this catches paths it can't cover (loaded-history
  // reconstruction, title-gen call hitting its own 4xx).
  if (isLikelyErrorTitle(cleaned)) return "";
  // Boundary-aware cap: a blind slice(0,30) severs Latin words ("…SSE 流式调" →
  // "…SSE 流"); capTitleAtBoundary backs a mid-word cut off to the last space.
  // Pure CJK (no whitespace) still hard-cuts at the limit.
  return capTitleAtBoundary(cleaned, TITLE_MAX_LENGTH);
}

type SdkTextContentBlock = { type?: string; text?: string };
type SdkAssistantLikeMessage = {
  type?: string;
  message?: { content?: SdkTextContentBlock[] };
};
type SdkResultLikeMessage = {
  type?: string;
  subtype?: string;
  result?: string;
  messages?: Array<{ role: string; content?: SdkTextContentBlock[] }>;
};

function textFromContentBlocks(
  content: SdkTextContentBlock[] | undefined,
): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

export function extractTitleTextFromSdkMessage(
  message: unknown,
): string | null {
  if (!message || typeof message !== "object") return null;
  const typed = message as SdkAssistantLikeMessage & SdkResultLikeMessage;
  if (typed.type === "assistant") {
    const text = textFromContentBlocks(typed.message?.content);
    return text || null;
  }
  if (
    typed.type === "result" &&
    typed.subtype === "success" &&
    Array.isArray(typed.messages)
  ) {
    const lastAssistant = typed.messages
      .filter((m) => m.role === "assistant")
      .pop();
    const text = textFromContentBlocks(lastAssistant?.content);
    return text || null;
  }
  if (
    typed.type === "result" &&
    typed.subtype === "success" &&
    typeof typed.result === "string"
  ) {
    const text = typed.result.trim();
    return text || null;
  }
  return null;
}

export interface OneShotTextRequest {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly providerEnv?: ProviderEnv;
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  /** Enables SDK text deltas for a single no-tool workbench run. */
  readonly streamText?: boolean;
  readonly throwOnTimeout?: boolean;
  /** Host-owned controller used to stop a workbench one-shot run. */
  readonly abortController?: AbortController;
  readonly toolset?: WorkbenchAgentToolsetRequest;
  readonly onProgress?: (progress: OneShotTextProgressUpdate) => void;
}

export interface OneShotTextProgressUpdate {
  readonly kind: WorkbenchAiRunProgressKind;
  readonly message: string;
  readonly partialOutput?: string;
}

const MAX_ONE_SHOT_RECOVERY_CONTEXT_CHARS = 24_000;

type OneShotProgressMessage = {
  readonly type?: unknown;
  readonly message?: {
    readonly content?: unknown;
  };
};

function textFromOneShotToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromOneShotToolResult(item))
      .filter(Boolean)
      .join("\n");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (record.content !== undefined)
    return textFromOneShotToolResult(record.content);
  return "";
}

/** 只提取只读工具返回，用于轮次耗尽时的内部收敛提示。 */
export function extractOneShotToolContextFromSdkMessage(
  message: unknown,
): string {
  if (!message || typeof message !== "object") return "";
  const typed = message as {
    readonly type?: unknown;
    readonly message?: { readonly content?: unknown };
  };
  if (typed.type !== "user" || !Array.isArray(typed.message?.content))
    return "";
  const chunks = typed.message.content
    .filter((block): block is Record<string, unknown> =>
      Boolean(block && typeof block === "object"),
    )
    .filter(
      (block) =>
        (block.type === "tool_result" || block.type === "mcp_tool_result") &&
        block.is_error !== true,
    )
    .map((block) => textFromOneShotToolResult(block.content))
    .filter(Boolean);
  return chunks.join("\n\n").slice(0, MAX_ONE_SHOT_RECOVERY_CONTEXT_CHARS);
}

export function extractOneShotSdkError(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const typed = message as {
    readonly type?: unknown;
    readonly subtype?: unknown;
    readonly errors?: unknown;
    readonly error?: unknown;
  };
  if (
    typed.type === "result" &&
    typeof typed.subtype === "string" &&
    typed.subtype.startsWith("error_")
  ) {
    const errors = Array.isArray(typed.errors)
      ? typed.errors
          .filter((item): item is string => typeof item === "string")
          .join("; ")
      : "";
    return errors || `Claude SDK returned ${typed.subtype}.`;
  }
  if (typed.type === "assistant" && typeof typed.error === "string") {
    return `Claude SDK returned ${typed.error}.`;
  }
  return null;
}

/** Extracts a text delta from Claude Agent SDK partial-message events. */
export function extractOneShotTextDeltaFromSdkMessage(
  message: unknown,
): string {
  if (!message || typeof message !== "object") return "";
  const record = message as {
    readonly type?: unknown;
    readonly event?: unknown;
  };
  if (record.type !== "stream_event") return "";
  if (!record.event || typeof record.event !== "object") return "";
  const event = record.event as {
    readonly type?: unknown;
    readonly delta?: unknown;
    readonly content_block?: unknown;
  };
  if (
    event.type === "content_block_delta" &&
    event.delta &&
    typeof event.delta === "object"
  ) {
    const delta = event.delta as {
      readonly type?: unknown;
      readonly text?: unknown;
    };
    return delta.type === "text_delta" && typeof delta.text === "string"
      ? delta.text
      : "";
  }
  if (
    event.type === "content_block_start" &&
    event.content_block &&
    typeof event.content_block === "object"
  ) {
    const contentBlock = event.content_block as {
      readonly type?: unknown;
      readonly text?: unknown;
    };
    return contentBlock.type === "text" && typeof contentBlock.text === "string"
      ? contentBlock.text
      : "";
  }
  return "";
}

export function isOneShotMaxTurnsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /error_max_turns|reached maximum number of turns|maximum number of turns/iu.test(
    message,
  );
}

const NOVEL_CONTEXT_TOOL_LABELS: Readonly<Record<string, string>> = {
  novel_world_get_context: "世界架构",
  novel_narrative_get_context: "剧情工程",
  novel_timeline_get_context: "时间线",
  novel_items_get_context: "物品库",
  novel_characters_get_context: "人物库",
  novel_cultivation_get_context: "修行体系",
  novel_factions_get_context: "势力",
  novel_manuscript_get_context: "章节正文",
  novel_continuity_get_context: "章节连续性",
  novel_inspiration_get_context: "灵感",
};

function oneShotProgressForSdkMessage(
  message: unknown,
): OneShotTextProgressUpdate | null {
  if (!message || typeof message !== "object") return null;
  const typed = message as OneShotProgressMessage;
  if (typed.type === "user") {
    return { kind: "intent", message: "正在整理已读取的资料" };
  }
  if (typed.type !== "assistant") return null;
  const content = typed.message?.content;
  if (!Array.isArray(content)) return null;
  const toolCall = [...content]
    .reverse()
    .find((block): block is { readonly type: string; readonly name: string } =>
      Boolean(
        block &&
          typeof block === "object" &&
          "type" in block &&
          ((block as { type?: unknown }).type === "mcp_tool_use" ||
            (block as { type?: unknown }).type === "tool_use") &&
          "name" in block &&
          typeof (block as { name?: unknown }).name === "string",
      ),
    );
  if (toolCall) {
    const normalizedToolName = toolCall.name.replace(/^mcp__[^_]+__/u, "");
    const label = NOVEL_CONTEXT_TOOL_LABELS[normalizedToolName];
    return label
      ? { kind: "tool", message: `正在读取${label}` }
      : { kind: "tool", message: "正在读取项目资料" };
  }
  const hasText = content.some((block) =>
    Boolean(
      block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string" &&
        (block as { text: string }).text.trim(),
    ),
  );
  return hasText ? { kind: "status", message: "正在生成结果" } : null;
}

export class OneShotTextTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`One-shot text generation timed out after ${timeoutMs}ms.`);
    this.name = "OneShotTextTimeoutError";
  }
}

export class OneShotTextCancelledError extends Error {
  constructor() {
    super("本次 AI 生成已取消");
    this.name = "OneShotTextCancelledError";
  }
}

export function resolveOneShotTextMaxTurns(
  requestedMaxTurns: number | undefined,
  hasTools: boolean,
): number {
  if (!hasTools) return 1;
  if (requestedMaxTurns === undefined || !Number.isFinite(requestedMaxTurns))
    return 8;
  return Math.max(1, Math.min(16, Math.round(requestedMaxTurns)));
}

export function resolveOneShotReadToolCallLimit(
  value: unknown,
): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.min(10, Math.round(parsed)));
}

/**
 * Tool-free, single-turn workbench calls can use the in-process provider
 * client. Subscription providers have no host API key and therefore retain
 * the SDK path; provider-backed calls do not need a Claude CLI subprocess.
 */
export function shouldUseDirectOneShotText(
  request: OneShotTextRequest,
): boolean {
  return (
    request.providerEnv !== undefined &&
    request.toolset === undefined &&
    resolveOneShotTextMaxTurns(request.maxTurns, false) === 1
  );
}

/**
 * Stateless text generation for compact workbench actions. It uses the normal
 * provider route but never joins or persists a Chat session. A workbench may
 * opt into a host-owned, read-only toolset for project context lookup.
 */
export async function generateOneShotText(
  request: OneShotTextRequest,
): Promise<string | null> {
  if (shouldUseDirectOneShotText(request)) {
    const timeoutMs = request.timeoutMs ?? 60_000;
    const providerEnv = request.providerEnv;
    if (!providerEnv) return null;
    const directOneShot = await import("./direct-one-shot");
    try {
      return await directOneShot.generateDirectOneShotText({
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        workspacePath: request.workspacePath,
        model: request.model,
        providerEnv,
        streamText: request.streamText,
        timeoutMs,
        abortController: request.abortController,
        onProgress: (partialOutput) => {
          request.onProgress?.({
            kind: "status",
            message: "正在生成结果",
            partialOutput,
          });
        },
      });
    } catch (error) {
      if (error instanceof directOneShot.DirectOneShotCancelledError) {
        throw new OneShotTextCancelledError();
      }
      if (error instanceof directOneShot.DirectOneShotTimeoutError) {
        if (request.throwOnTimeout) {
          throw new OneShotTextTimeoutError(timeoutMs);
        }
        return null;
      }
      throw error;
    }
  }

  const bridge =
    request.providerEnv?.apiProtocol === "openai"
      ? startOneShotBridge(
          request.providerEnv,
          request.model,
          `workbench-run:${request.providerEnv.baseUrl ?? "anthropic"}`,
        )
      : null;
  try {
    let activeRequest = request;
    let recoveryContext = "";
    const run = async (toolConfiguration?: {
      readonly adapterId: string;
      readonly server: Awaited<
        ReturnType<
          typeof import("./tools/novel-workbench-tool").createNovelWorkbenchServer
        >
      >;
      readonly readTools: readonly string[];
    }): Promise<string | null> => {
      const cliPath = resolveClaudeCodeCli();
      const allowedReadTools = toolConfiguration?.readTools.map(
        (name) => `mcp__${toolConfiguration.adapterId}__${name}`,
      );
      const readToolCallLimit = resolveOneShotReadToolCallLimit(
        activeRequest.toolset?.context?.readToolCallLimit,
      );
      let allowedReadToolCallCount = 0;
      const oneShot = await createGuardedSdkQuery(cliPath, () =>
        query({
          prompt: activeRequest.prompt,
          options: {
            ...(activeRequest.abortController
              ? { abortController: activeRequest.abortController }
              : {}),
            maxTurns: resolveOneShotTextMaxTurns(
              activeRequest.maxTurns,
              Boolean(toolConfiguration),
            ),
            cwd: activeRequest.workspacePath,
            settingSources: [],
            permissionMode: toolConfiguration ? "default" : "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            pathToClaudeCodeExecutable: cliPath,
            env: buildClaudeSessionEnv(
              activeRequest.providerEnv,
              activeRequest.model,
              {
                bridgeToken: bridge?.token,
                providerId:
                  activeRequest.providerEnv?.providerId ??
                  SUBSCRIPTION_PROVIDER_ID,
              },
            ),
            systemPrompt: activeRequest.systemPrompt,
            thinking: { type: "disabled" },
            effort: "low",
            includePartialMessages: activeRequest.streamText === true,
            persistSession: false,
            mcpServers: toolConfiguration
              ? { [toolConfiguration.adapterId]: toolConfiguration.server }
              : {},
            tools: [],
            ...(allowedReadTools
              ? {
                  allowedTools: allowedReadTools,
                  canUseTool: async (toolName: string) => {
                    if (!allowedReadTools.includes(toolName)) {
                      return {
                        behavior: "deny" as const,
                        message: "一次性工作台 Agent 只允许读取项目上下文。",
                      };
                    }
                    if (
                      readToolCallLimit !== undefined &&
                      allowedReadToolCallCount >= readToolCallLimit
                    ) {
                      return {
                        behavior: "deny" as const,
                        message: `只读资料调用已达到 ${readToolCallLimit} 次上限。请停止检索，立即依据已取得资料返回最终结果。`,
                      };
                    }
                    allowedReadToolCallCount += 1;
                    return { behavior: "allow" as const };
                  },
                }
              : {}),
            ...(activeRequest.model
              ? {
                  model: applyProviderContextWindowSuffix(
                    activeRequest.model,
                    activeRequest.providerEnv?.providerId ??
                      SUBSCRIPTION_PROVIDER_ID,
                  ),
                }
              : {}),
          },
        }),
      );
      const queryPromise = (async (): Promise<string | null> => {
        let latest: string | null = null;
        let streamedOutput = "";
        for await (const message of oneShot) {
          const textDelta = extractOneShotTextDeltaFromSdkMessage(message);
          if (textDelta) {
            streamedOutput += textDelta;
            activeRequest.onProgress?.({
              kind: "status",
              message: "正在生成结果",
              partialOutput: streamedOutput,
            });
          }
          const toolContext = extractOneShotToolContextFromSdkMessage(message);
          if (toolContext) {
            recoveryContext = `${recoveryContext}\n\n${toolContext}`
              .trim()
              .slice(0, MAX_ONE_SHOT_RECOVERY_CONTEXT_CHARS);
          }
          const progress = oneShotProgressForSdkMessage(message);
          if (progress) activeRequest.onProgress?.(progress);
          const sdkError = extractOneShotSdkError(message);
          if (sdkError) throw new Error(sdkError);
          latest = extractTitleTextFromSdkMessage(message) ?? latest;
        }
        return latest ?? streamedOutput;
      })();
      const timeoutMs =
        activeRequest.timeoutMs ?? (toolConfiguration ? 120_000 : 60_000);
      const timedOut = Symbol("one-shot-timeout");
      const cancelled = Symbol("one-shot-cancelled");
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let removeAbortListener: (() => void) | undefined;
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
      });
      const cancellation = activeRequest.abortController
        ? new Promise<typeof cancelled>((resolve) => {
            const signal = activeRequest.abortController?.signal;
            const onAbort = () => {
              void oneShot.return(undefined as never).catch(() => undefined);
              resolve(cancelled);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () =>
              signal?.removeEventListener("abort", onAbort);
          })
        : null;
      let result: string | null | typeof timedOut | typeof cancelled;
      try {
        result = await Promise.race([
          queryPromise,
          timeout,
          ...(cancellation ? [cancellation] : []),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        removeAbortListener?.();
      }
      if (result === cancelled) throw new OneShotTextCancelledError();
      if (result === timedOut) {
        try {
          await Promise.race([
            oneShot.return(undefined as never),
            new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
          ]);
        } catch {
          // Best-effort SDK subprocess cleanup after the request deadline.
        }
        if (activeRequest.throwOnTimeout)
          throw new OneShotTextTimeoutError(timeoutMs);
        return null;
      }
      const output = result;
      return output?.trim() || null;
    };

    const runWithOptionalToolset = async (): Promise<string | null> => {
      if (!activeRequest.toolset) return await run();

      const [contextModule, toolModule] = await Promise.all([
        import("./novel-workbench-context"),
        import("./tools/novel-workbench-tool"),
      ]);
      return await contextModule.runWithNovelWorkbenchToolset(
        activeRequest.toolset,
        {
          sessionId: `workbench-run-${randomUUID()}`,
          workspace: activeRequest.workspacePath,
        },
        async () =>
          run({
            adapterId: contextModule.NOVEL_WORKBENCH_SDK_ADAPTER_ID,
            server: await toolModule.createNovelWorkbenchServer(),
            readTools: contextModule.NOVEL_WORKBENCH_READ_TOOL_NAMES,
          }),
      );
    };

    try {
      return await runWithOptionalToolset();
    } catch (error) {
      if (!request.toolset || !isOneShotMaxTurnsError(error)) throw error;

      request.onProgress?.({
        kind: "status",
        message: "已达到轮次上限，依据已读取资料直接输出",
      });
      activeRequest = {
        ...request,
        prompt: [
          request.prompt.slice(0, 36_000),
          recoveryContext
            ? `【本轮已读取资料快照】\n${recoveryContext}`
            : "【本轮已读取资料快照】\n本轮没有收到可复用的工具返回，请依据原始请求中的已有资料直接完成。",
          "【收敛要求】不得调用工具，不得重新读取，直接输出最终结果。",
        ].join("\n\n"),
        systemPrompt: `${request.systemPrompt}\n\n上一轮已达到轮次上限。本轮必须依据上面保留的已读资料直接输出最终结果，不得重新开始读取。`,
        maxTurns: 1,
        toolset: undefined,
      };
      return await run();
    }
  } finally {
    bridge?.release();
  }
}

/**
 * Generate a short session title using the SDK query() path.
 * Accepts multiple QA rounds (typically 3) for richer context.
 * Uses the user's current model and provider — single-turn, non-persistent.
 * Returns cleaned title string on success, null on any failure (silent).
 */
export async function generateTitle(
  rounds: TitleRound[],
  model: string,
  providerEnv?: ProviderEnv,
): Promise<string | null> {
  // PRD #124: register a per-call bridge token if the title-gen provider is
  // OpenAI-protocol — the SDK subprocess routes to ITS upstream via a
  // dedicated /bridge/<token> path, fully isolated from the active session.
  // For Anthropic-direct / subscription title-gen, no token is needed.
  const bridge =
    providerEnv?.apiProtocol === "openai"
      ? startOneShotBridge(
          providerEnv,
          model,
          `title-gen:${providerEnv.baseUrl ?? "anthropic"}`,
        )
      : null;
  try {
    return await generateTitleInner(rounds, model, providerEnv, bridge?.token);
  } finally {
    bridge?.release();
  }
}

async function generateTitleInner(
  rounds: TitleRound[],
  model: string,
  providerEnv?: ProviderEnv,
  bridgeToken?: string,
): Promise<string | null> {
  const startTime = Date.now();
  const sessionId = randomUUID();

  try {
    const cliPath = resolveClaudeCodeCli();
    const cwd = join(homedir(), ".myagents", "projects");
    ensureDirSync(cwd);

    // Pass `model` as the override so CLAUDE_CODE_AUTO_COMPACT_WINDOW is
    // computed for the title-gen model, not the active Tab session's model.
    const env = buildClaudeSessionEnv(providerEnv, model, {
      bridgeToken,
      providerId: providerEnv?.providerId ?? SUBSCRIPTION_PROVIDER_ID,
    });
    const launchModel = applyContextWindowSuffixForContextLength(
      model,
      Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
    );
    const prompt = buildUserPrompt(rounds);

    async function* titlePrompt() {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: prompt },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    }

    const titleQuery = await createGuardedSdkQuery(cliPath, () =>
      query({
        prompt: titlePrompt(),
        options: {
          maxTurns: 1,
          sessionId,
          cwd,
          settingSources: ["project"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          pathToClaudeCodeExecutable: cliPath,
          env,
          systemPrompt: SYSTEM_PROMPT,
          // Title generation is a short text-classification task. Adaptive thinking
          // can spend the whole one-shot budget on hidden reasoning or delay first
          // text on strong reasoning models, so force the cheapest text path.
          thinking: { type: "disabled" },
          effort: "low",
          includePartialMessages: false,
          persistSession: false,
          mcpServers: {},
          // Security (review #2): title generation is a PURE-TEXT task whose only
          // input is (attacker-influenceable) transcript text. Running it at
          // bypassPermissions with built-in tools available means an indirect
          // prompt injection in the transcript could make the title model emit a
          // Bash/Write tool_use that then executes with NO approval. `tools: []`
          // is the SDK-native "disable ALL built-in tools" (sdk.d.ts:1360), and
          // `mcpServers:{}` already removes MCP tools — together there is nothing
          // to invoke, so bypassPermissions becomes moot. The model can still
          // produce the title text (tools are orthogonal to generation).
          tools: [],
          // Wrap with [1m] when this provider's contextLength >200K (#335) so SDK
          // uses the 1M path even for a one-shot title-gen subprocess. SDK strips
          // the suffix before the wire.
          ...(launchModel ? { model: launchModel } : {}),
        },
      }),
    );

    let titleText: string | null = null;

    // Race: SDK response vs timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), BUILTIN_TITLE_TIMEOUT_MS);
    });

    const queryPromise = (async (): Promise<string | null> => {
      for await (const message of titleQuery) {
        const text = extractTitleTextFromSdkMessage(message);
        if (text) return text;
      }
      return null;
    })();

    titleText = await Promise.race([queryPromise, timeoutPromise]);

    // If timeout won, terminate the SDK iterator to release the subprocess
    if (titleText === null) {
      try {
        titleQuery.return(undefined as never);
      } catch {
        /* ignore */
      }
    }

    if (!titleText) {
      console.warn(
        `[title-generator] No title text returned (${Date.now() - startTime}ms)`,
      );
      return null;
    }

    const cleaned = cleanTitle(titleText);
    console.log(
      `[title-generator] Generated title: "${cleaned}" (${Date.now() - startTime}ms, ${rounds.length} rounds)`,
    );
    return cleaned.length > 0 ? cleaned : null;
  } catch (err) {
    console.warn("[title-generator] SDK query failed:", err);
    return null;
  }
}

// ─── External runtime title generation ───

/**
 * Create a FRESH runtime instance (not the cached factory singleton) for title
 * generation. This isolates title-gen's process lifecycle from the main
 * session's runtime — CC's singleton keeps block-index maps on the instance,
 * and a concurrent title-gen startSession would clear those maps and corrupt
 * the main session's tool-tracking state.
 */
function createFreshRuntime(type: RuntimeType): AgentRuntime {
  switch (type) {
    case "claude-code":
      return new ClaudeCodeRuntime();
    case "codex":
      return new CodexRuntime();
    case "gemini":
      return new GeminiRuntime();
    default:
      throw new Error(
        `Unsupported external runtime for title generation: ${type}`,
      );
  }
}

/**
 * Pick the LEAST-capable per-runtime mode that still lets a pure-text turn
 * complete without blocking. Title generation is text-only; the previous code
 * forced the MOST permissive mode (fullAgency/full-auto/yolo) "to be safe",
 * which was backwards — it made an injected tool_use execute with no approval
 * (review #2). The happy text path needs no tools, so:
 *   - claude-code → fullAgency, but `TITLE_GEN_DISALLOWED_TOOLS` strips every
 *     tool from context (the real guard for CC; bypass is then moot).
 *   - codex       → 'suggest' = read-only sandbox (codex.ts:1082): an injected
 *     command can't touch the FS/network, and approval='untrusted' surfaces a
 *     permission_request that the caller settles+kills (no execution).
 *   - gemini      → 'default' = approval-required (NOT yolo): a tool attempt
 *     raises a permission_request → settled+killed; text still streams freely.
 * Any tool attempt therefore degrades to "no title", never to execution.
 */
function titlePermissionMode(runtimeType: RuntimeType): string {
  switch (runtimeType) {
    case "claude-code":
      return "fullAgency"; // tools stripped via disallowedTools
    case "codex":
      return "suggest"; // → approval=untrusted + sandbox=read-only
    case "gemini":
      return "default"; // → approval-required (no yolo)
    default:
      return "auto";
  }
}

/**
 * Project a title utility turn onto the shared external-runtime start contract.
 * Runtime identity is preserved, while Managed Codex deliberately receives no
 * workspace MCP injection. Kept pure so the identity/capability boundary is
 * regression-testable without spawning a real CLI process.
 */
export function buildExternalTitleSessionOptions(input: {
  sessionId: string;
  workspacePath: string;
  userPrompt: string;
  runtimeType: RuntimeType;
  model: string;
  runtimeSource?: RuntimeSource;
}): SessionStartOptions {
  return {
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    initialMessage: input.userPrompt,
    systemPromptAppend: SYSTEM_PROMPT,
    ...(input.model ? { model: input.model } : {}),
    permissionMode: titlePermissionMode(input.runtimeType),
    // Strip all tools from the model's context (Claude Code honours this;
    // Codex/Gemini are constrained by the read-only/approval mode above).
    disallowedTools: TITLE_GEN_DISALLOWED_TOOLS,
    maxTurns: 1,
    // Placeholder — title-gen passes its own systemPromptAppend and explicit permissionMode,
    // so scenario-driven branches in each runtime (default-mode/L2-prompt) never fire.
    scenario: { type: "desktop" },
    // Runtime Source is part of Codex identity. Without this, startSession()
    // defaults to system-cli even when the owning Session is Managed Codex.
    ...(input.runtimeType === "codex"
      ? {
          runtimeSource: input.runtimeSource,
          // Managed Codex has an isolated CODEX_HOME; an explicit empty set means
          // this utility process receives no workspace MCP injection. system-cli
          // intentionally keeps its user-owned native config unchanged.
          ...(input.runtimeSource === "managed-provider"
            ? {
                mcpServers: [],
                // Title generation is a short text task. Do not inherit a user's xhigh
                // effort or persist a throwaway Managed Codex thread.
                reasoningEffort: "low",
                ephemeral: true,
              }
            : {}),
        }
      : {}),
  };
}

/**
 * Generate a title using the session's external runtime (claude-code / codex /
 * gemini). Spawns a brand-new short-lived process, sends the title prompt as
 * initialMessage, accumulates text_delta, returns on turn_complete or
 * session_complete. The process is always stopped afterwards (including on
 * timeout), so Gemini's temporary GEMINI_SYSTEM_MD file is cleaned up.
 *
 * Silent-fail contract matches generateTitle(): any error → null, frontend
 * falls back to truncated first message.
 */
export async function generateTitleExternal(
  rounds: TitleRound[],
  runtimeType: RuntimeType,
  model: string,
  workspacePath: string,
  runtimeSource?: RuntimeSource,
): Promise<string | null> {
  const startTime = Date.now();
  // Plain UUID — Claude Code CLI rejects `--session-id <non-uuid>` with
  // "Invalid session ID. Must be a valid UUID." A `title-` prefix would tank
  // every CC title-gen call. Logs are already tagged with `[title-generator]`.
  const titleSessionId = randomUUID();
  const userPrompt = buildUserPrompt(rounds);

  let runtime: AgentRuntime;
  try {
    runtime = createFreshRuntime(runtimeType);
  } catch (err) {
    console.warn("[title-generator] external runtime unavailable:", err);
    return null;
  }

  let collected = "";
  let handle: RuntimeProcess | null = null;
  let resolved = false;
  let settle: (val: string | null) => void = () => {
    /* placeholder replaced by promise ctor */
  };
  let outcome:
    | "ok"
    | "empty"
    | "timeout"
    | "start-failed"
    | "error"
    | "permission" = "timeout";

  const resultPromise = new Promise<string | null>((resolve) => {
    settle = (val: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };
  });

  // Hoist startSession out of the Promise ctor so we can await it on the timeout path —
  // without that, a 30s timeout during Gemini's cold-start handshake leaves `handle === null`
  // forever, stranding the child process + its GEMINI_SYSTEM_MD tmp file.
  const titleSessionOptions = buildExternalTitleSessionOptions({
    sessionId: titleSessionId,
    workspacePath,
    userPrompt,
    runtimeType,
    model,
    runtimeSource,
  });

  const startPromise = runtime.startSession(titleSessionOptions, (event) => {
    // Guard: events can still stream in after we've settled (timeout winner / late turn_complete).
    if (resolved) return;
    if (event.kind === "text_delta") {
      collected += event.text;
    } else if (event.kind === "turn_complete") {
      outcome = collected ? "ok" : "empty";
      settle(collected || null);
    } else if (event.kind === "session_complete") {
      // On non-success (Gemini session/prompt error, Codex turn error) a few tokens may have
      // streamed before the failure — those partial fragments make garbage titles. Settle null.
      if (event.subtype === "success") {
        outcome = collected ? "ok" : "empty";
        settle(collected || null);
      } else {
        outcome = "error";
        settle(null);
      }
    } else if (event.kind === "permission_request") {
      // Title-gen is text-only and forces the most permissive mode per runtime so this shouldn't
      // fire. If it does (e.g. Gemini set_mode non-fatally fell back to default), don't deadlock
      // waiting on an approval we'd never grant — settle with whatever text we have and let the
      // cleanup path kill the process. No respondPermission call needed.
      outcome = "permission";
      settle(collected || null);
    }
  });

  startPromise
    .then((h) => {
      handle = h;
      // Late handle after timeout already fired — kill immediately, nobody else will.
      if (resolved) {
        runtime.stopSession(h).catch(() => {
          /* ignore */
        });
      }
    })
    .catch((err) => {
      outcome = "start-failed";
      console.warn("[title-generator] external startSession failed:", err);
      settle(null);
    });

  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), EXTERNAL_TIMEOUT_MS),
  );
  const titleText = await Promise.race([resultPromise, timeoutPromise]);

  // #296 review (Codex C2): mark the attempt finished now. If the TIMEOUT won the
  // race, `settle()` was never called so `resolved` is still false — and the
  // late-handle guard in `startPromise.then` (`if (resolved) stopSession`) would
  // then NOT stop a child whose cold-start resolves AFTER the 5s grace below,
  // leaking the title-gen CLI process. Setting it true here makes that late `.then`
  // always stop the process, and also makes any late stream event a no-op.
  resolved = true;

  // Cleanup path — three cases:
  //   1. handle already set → stopSession directly.
  //   2. handle still null because we timed out mid-handshake → wait briefly (5s) for startSession
  //      to resolve, then stop. This is the critical leak fix: without it, Gemini's ACP handshake
  //      could complete AFTER our 30s budget, assign `handle` via the .then() above, and nobody
  //      would ever kill the subprocess.
  //   3. startPromise rejects during the grace window → .catch above already fired, no handle to
  //      stop. Swallow rejection in the race so we don't propagate.
  if (handle) {
    try {
      await runtime.stopSession(handle);
    } catch {
      /* ignore */
    }
  } else {
    const lateHandle = await Promise.race([
      startPromise.catch(() => null),
      new Promise<RuntimeProcess | null>((r) =>
        setTimeout(() => r(null), 5_000),
      ),
    ]);
    if (lateHandle) {
      try {
        await runtime.stopSession(lateHandle);
      } catch {
        /* ignore */
      }
    }
  }

  const durationMs = Date.now() - startTime;
  if (!titleText || !titleText.trim()) {
    // Preserve the outcome tag the callback/catch/timeout set so ops can distinguish
    // timeout / start-failed / error / empty in the logs.
    console.warn(
      `[title-generator] external ${runtimeType} produced no title (outcome=${outcome}, ${durationMs}ms)`,
    );
    return null;
  }

  const cleaned = cleanTitle(titleText);
  console.log(
    `[title-generator] Generated title via ${runtimeType}: "${cleaned}" (outcome=${outcome}, ${durationMs}ms, ${rounds.length} rounds)`,
  );
  return cleaned.length > 0 ? cleaned : null;
}
