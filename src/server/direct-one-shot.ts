/**
 * Direct, stateless text generation for workbench actions that do not need
 * project tools. This path intentionally bypasses Claude Agent SDK process
 * startup. OpenAI-compatible providers reuse the in-process bridge; Anthropic
 * providers use the Messages API directly.
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

import type { ProviderEnv } from "./provider-types";
import {
  anthropicAuthHeaders,
  joinAnthropicMessagesUrl,
} from "./provider-probe";
import { createBridgeHandler } from "./openai-bridge/handler";
import { SSEParser } from "./openai-bridge/utils/sse-parser";
import { getProxyForProviderUrl } from "./proxy-state";
import {
  canonicalizeManagedProviderEnv,
  type ResolvedProviderEnv,
} from "./utils/admin-config";
import {
  resolveManagedOAuthCredential,
  type ManagedOAuthPurpose,
} from "./utils/management-api-client";

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const MAX_ERROR_BODY_CHARS = 600;

export interface DirectOneShotRequest {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly providerEnv: ProviderEnv;
  readonly streamText?: boolean;
  readonly timeoutMs: number;
  readonly abortController?: AbortController;
  readonly onProgress?: (partialOutput: string) => void;
}

export class DirectOneShotTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Direct one-shot text generation timed out after ${timeoutMs}ms.`);
    this.name = "DirectOneShotTimeoutError";
  }
}

export class DirectOneShotCancelledError extends Error {
  constructor() {
    super("本次 AI 生成已取消");
    this.name = "DirectOneShotCancelledError";
  }
}

type DirectResponseEvent = {
  readonly type?: unknown;
  readonly delta?:
    | { readonly type?: unknown; readonly text?: unknown }
    | string;
  readonly content_block?: { readonly type?: unknown; readonly text?: unknown };
  readonly choices?: readonly {
    readonly delta?: { readonly content?: unknown };
    readonly message?: { readonly content?: unknown };
  }[];
  readonly output_text?: unknown;
  readonly output?: unknown;
};

type DirectResponseHandle = {
  readonly response: Response;
  readonly cleanup: () => Promise<void>;
};

function normalizeProviderEnv(providerEnv: ProviderEnv): ProviderEnv {
  if (!providerEnv.credentialSource) return providerEnv;
  return canonicalizeManagedProviderEnv(providerEnv as ResolvedProviderEnv);
}

function createDeadline(request: DirectOneShotRequest): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly cancelled: () => boolean;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const parentSignal = request.abortController?.signal;
  let timedOut = false;
  let cancelled = false;
  const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  const onParentAbort = (): void => {
    cancelled = true;
    controller.abort();
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
    cleanup: () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function throwIfDeadlineEnded(
  deadline: ReturnType<typeof createDeadline>,
): void {
  if (deadline.timedOut()) throw new DirectOneShotTimeoutError(0);
  if (deadline.cancelled()) throw new DirectOneShotCancelledError();
}

function errorFromResponse(response: Response, body: string): Error {
  const detail = body
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_ERROR_BODY_CHARS);
  return new Error(
    `Direct provider request failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
  );
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractTextValue(item)).join("");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (record.type === "text" && typeof record.content === "string") {
    return record.content;
  }
  if (record.content !== undefined) return extractTextValue(record.content);
  return "";
}

function extractTextFromResponseBody(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const anthropicText = extractTextValue(record.content);
  if (anthropicText) return anthropicText;
  const openAiChoices = record.choices;
  if (Array.isArray(openAiChoices)) {
    const choiceText = openAiChoices
      .map((choice) => {
        if (!choice || typeof choice !== "object") return "";
        const typed = choice as Record<string, unknown>;
        const message = typed.message;
        return message && typeof message === "object"
          ? extractTextValue((message as Record<string, unknown>).content)
          : "";
      })
      .join("");
    if (choiceText) return choiceText;
  }
  const outputText = extractTextValue(record.output_text);
  if (outputText) return outputText;
  return extractTextValue(record.output);
}

function extractTextDelta(event: DirectResponseEvent): string {
  if (
    event.type === "content_block_delta" &&
    event.delta !== null &&
    typeof event.delta === "object" &&
    event.delta.type === "text_delta" &&
    typeof event.delta.text === "string"
  ) {
    return event.delta.text;
  }
  if (
    event.type === "content_block_start" &&
    event.content_block?.type === "text" &&
    typeof event.content_block.text === "string"
  ) {
    return event.content_block.text;
  }
  if (Array.isArray(event.choices)) {
    return event.choices
      .map((choice) => extractTextValue(choice?.delta?.content))
      .join("");
  }
  if (event.type === "response.output_text.delta") {
    return typeof event.delta === "string" ? event.delta : "";
  }
  if (event.type === "response.output_text.done") {
    return typeof event.output_text === "string"
      ? event.output_text
      : typeof event.delta === "string"
        ? event.delta
        : "";
  }
  return "";
}

function configuredMaxOutputTokens(
  providerEnv: ProviderEnv,
): number | undefined {
  const value = providerEnv.maxOutputTokens;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

async function readDirectResponse(
  response: Response,
  deadline: ReturnType<typeof createDeadline>,
  streamText: boolean,
  onProgress: ((partialOutput: string) => void) | undefined,
): Promise<string> {
  if (!response.ok) {
    const body = await response.text();
    throw errorFromResponse(response, body);
  }

  const responseIsStream =
    response.headers.get("content-type")?.includes("text/event-stream") ??
    false;
  // Some OpenAI-compatible providers ignore `stream: true` and still return a
  // regular JSON response. Treat the content type as authoritative so that a
  // valid response is not discarded by the SSE parser.
  if (!responseIsStream) {
    const body = await response.json();
    const output = extractTextFromResponseBody(body).trim();
    if (output) onProgress?.(output);
    return output;
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      throwIfDeadlineEnded(deadline);
      const events = parser.feed(decoder.decode(value, { stream: true }));
      for (const event of events) {
        if (event.data === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }
        const delta = extractTextDelta(parsed as DirectResponseEvent);
        if (delta) {
          output += delta;
          onProgress?.(output);
        }
      }
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}

function buildDirectAnthropicBody(request: DirectOneShotRequest): string {
  return JSON.stringify({
    model: request.model,
    system: request.systemPrompt,
    max_tokens:
      configuredMaxOutputTokens(request.providerEnv) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: request.prompt }],
    stream: request.streamText === true,
  });
}

async function callAnthropicDirect(
  request: DirectOneShotRequest,
  providerEnv: ProviderEnv,
  deadline: ReturnType<typeof createDeadline>,
): Promise<DirectResponseHandle> {
  if (providerEnv.credentialSource) {
    throw new Error(
      "Managed OAuth provider cannot use the Anthropic direct protocol.",
    );
  }
  // Match Claude SDK semantics: an Anthropic-protocol provider without an
  // explicit base URL uses the official endpoint.
  const url = joinAnthropicMessagesUrl(
    providerEnv.baseUrl ?? "https://api.anthropic.com",
  );
  const init: Parameters<typeof undiciFetch>[1] & {
    dispatcher?: Dispatcher;
  } = {
    method: "POST",
    headers: {
      ...anthropicAuthHeaders(providerEnv.authType, providerEnv.apiKey ?? ""),
      accept:
        request.streamText === true ? "text/event-stream" : "application/json",
    },
    body: buildDirectAnthropicBody({ ...request, providerEnv }),
    signal: deadline.signal,
  };
  const proxyUrl = providerEnv.providerId
    ? getProxyForProviderUrl(providerEnv.providerId, url)
    : undefined;
  let proxyAgent: ProxyAgent | undefined;
  if (proxyUrl) {
    proxyAgent = new ProxyAgent(proxyUrl);
    init.dispatcher = proxyAgent;
  }
  try {
    const response = (await undiciFetch(url, init)) as unknown as Response;
    return {
      response,
      cleanup: async () => {
        if (proxyAgent) {
          try {
            await proxyAgent.close();
          } catch {
            // The response has already been consumed; a dispatcher close
            // failure must not discard the generated text.
          }
        }
      },
    };
  } catch (error) {
    if (proxyAgent) {
      try {
        await proxyAgent.close();
      } catch {
        // Preserve the original fetch error.
      }
    }
    throw error;
  }
}

async function callOpenAiViaBridge(
  request: DirectOneShotRequest,
  providerEnv: ProviderEnv,
  deadline: ReturnType<typeof createDeadline>,
): Promise<DirectResponseHandle> {
  if (!providerEnv.baseUrl) {
    throw new Error("OpenAI provider has no base URL.");
  }
  const managedSource = providerEnv.credentialSource;
  let latestCredentialVersion: number | undefined;
  const purpose: ManagedOAuthPurpose = { purpose: "execution" };
  const resolveBearer = async (
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    if (!managedSource) return providerEnv.apiKey ?? "";
    const credential = await resolveManagedOAuthCredential(
      managedSource.providerId,
      { reason: "request" },
      signal,
      purpose,
    );
    if (!credential)
      throw new Error("Managed OAuth credential is unavailable.");
    latestCredentialVersion = credential.credentialVersion;
    return credential.accessToken;
  };
  const bearer = await resolveBearer(deadline.signal);
  const handler = createBridgeHandler({
    workspacePath: request.workspacePath,
    upstreamHeadersTimeoutMs: request.timeoutMs,
    logger: null,
    getUpstreamConfig: async (bridgeRequest) => ({
      providerId: providerEnv.providerId ?? "unknown-provider",
      baseUrl: providerEnv.baseUrl ?? "",
      apiKey: bearer,
      credentialVersion: latestCredentialVersion,
      model: request.model,
      maxOutputTokens: configuredMaxOutputTokens(providerEnv),
      maxOutputTokensParamName: providerEnv.maxOutputTokensParamName,
      upstreamFormat: providerEnv.upstreamFormat,
      recoverAuth: managedSource
        ? async (rejectedCredentialVersion: number) => {
            const recovered = await resolveManagedOAuthCredential(
              managedSource.providerId,
              { reason: "auth_recovery", rejectedCredentialVersion },
              bridgeRequest.signal,
              purpose,
            );
            if (!recovered)
              throw new Error("Managed OAuth recovery returned no credential.");
            latestCredentialVersion = recovered.credentialVersion;
            return {
              apiKey: recovered.accessToken,
              credentialVersion: recovered.credentialVersion,
            };
          }
        : undefined,
      reportOutcome: managedSource
        ? async (credentialVersion: number, httpStatus: number) => {
            await resolveManagedOAuthCredential(
              managedSource.providerId,
              {
                reason: "report",
                rejectedCredentialVersion: credentialVersion,
                httpStatus,
              },
              bridgeRequest.signal,
              purpose,
            );
          }
        : undefined,
    }),
  });
  const response = await handler(
    new Request("http://myagents.internal/bridge/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": bearer,
      },
      body: JSON.stringify({
        model: request.model,
        system: request.systemPrompt,
        max_tokens:
          configuredMaxOutputTokens(providerEnv) ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: request.prompt }],
        stream: request.streamText === true,
      }),
      signal: deadline.signal,
    }),
  );
  return { response, cleanup: async () => undefined };
}

export async function generateDirectOneShotText(
  request: DirectOneShotRequest,
): Promise<string | null> {
  const deadline = createDeadline(request);
  const providerEnv = normalizeProviderEnv(request.providerEnv);
  try {
    throwIfDeadlineEnded(deadline);
    const handle =
      providerEnv.apiProtocol === "openai"
        ? await callOpenAiViaBridge(request, providerEnv, deadline)
        : await callAnthropicDirect(request, providerEnv, deadline);
    try {
      throwIfDeadlineEnded(deadline);
      const output = await readDirectResponse(
        handle.response,
        deadline,
        request.streamText === true,
        request.onProgress,
      );
      throwIfDeadlineEnded(deadline);
      return output.trim() || null;
    } finally {
      await handle.cleanup();
    }
  } catch (error) {
    if (deadline.timedOut()) {
      throw new DirectOneShotTimeoutError(request.timeoutMs);
    }
    if (deadline.cancelled()) {
      throw new DirectOneShotCancelledError();
    }
    throw error;
  } finally {
    deadline.cleanup();
  }
}
