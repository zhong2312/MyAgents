import { Buffer } from "buffer";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { cancellableFetch } from "../utils/cancellation";
import { ensureMiroFishCompanion } from "../mirofish-companion";

const REQUEST_VERSION = 1;
const DEFAULT_MIROFISH_BASE_URL = "http://127.0.0.1:5103";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

interface RouteOptions {
  readonly baseUrl?: string;
  readonly apiSecretKey?: string;
  readonly fetchImpl?: typeof cancellableFetch;
  readonly modelProxyUrl?: string;
}

interface ParsedOperation {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function parseRunId(value: unknown): string {
  const runId = requireText(value, "runId");
  if (!/^novel-run-[a-z0-9]+$/u.test(runId)) {
    throw new Error("runId is invalid.");
  }
  return runId;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(
    normalized,
  );
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 255) && match[1] === "127";
}

function resolveMiroFishBaseUrl(value?: string): URL {
  let url: URL;
  try {
    url = new URL(value?.trim() || DEFAULT_MIROFISH_BASE_URL);
  } catch {
    throw new Error("MIROFISH_BASE_URL is not a valid URL.");
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MIROFISH_BASE_URL must be a plain loopback HTTP origin, for example http://127.0.0.1:5103.",
    );
  }
  return url;
}

function resolveLoopbackUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a loopback HTTP URL.`);
  }
  return url;
}

async function readWorkspaceProjectId(workspacePath: string): Promise<string> {
  if (!isAbsolute(workspacePath)) {
    throw new Error("workspacePath must be an absolute path.");
  }
  const workspace = resolve(workspacePath);
  try {
    if (!(await stat(workspace)).isDirectory()) {
      throw new Error("workspacePath must be a directory.");
    }
    const metadata = JSON.parse(await readFile(join(workspace, "novel.json"), "utf8")) as {
      projectId?: unknown;
    };
    if (typeof metadata.projectId !== "string" || !metadata.projectId.trim()) {
      throw new Error("novel.json does not contain a projectId.");
    }
    return metadata.projectId.trim();
  } catch (error) {
    if (error instanceof Error && /workspacePath|projectId/u.test(error.message)) {
      throw error;
    }
    throw new Error("workspacePath is not a readable novel project.");
  }
}

function parseOperation(request: Record<string, unknown>): ParsedOperation {
  if (request.version !== REQUEST_VERSION) {
    throw new Error("Unsupported world simulation request version.");
  }
  const operation = requireText(request.operation, "operation");
  const root = "/api/novel-simulation";
  if (operation === "capabilities") {
    return { method: "GET", path: `${root}/capabilities` };
  }
  if (operation === "list") {
    const query = new URLSearchParams({
      projectId: requireText(request.projectId, "projectId"),
    });
    return { method: "GET", path: `${root}/runs?${query}` };
  }
  if (operation === "create") {
    if (!isRecord(request.snapshot) || !isRecord(request.scenario)) {
      throw new Error("snapshot and scenario are required.");
    }
    return {
      method: "POST",
      path: `${root}/runs`,
      body: {
        snapshot: request.snapshot,
        scenario: request.scenario,
        ...(request.modelSelections
          ? { modelSelections: request.modelSelections }
          : {}),
      },
    };
  }

  const runId = encodeURIComponent(parseRunId(request.runId));
  if (operation === "get") {
    return { method: "GET", path: `${root}/runs/${runId}` };
  }
  if (
    operation === "start" ||
    operation === "pause" ||
    operation === "resume" ||
    operation === "advance" ||
    operation === "cancel"
  ) {
    return {
      method: "POST",
      path: `${root}/runs/${runId}/${operation}`,
      body: {},
    };
  }
  if (operation === "events") {
    const after =
      typeof request.after === "number" && Number.isInteger(request.after)
        ? Math.max(0, request.after)
        : 0;
    const limit =
      typeof request.limit === "number" && Number.isInteger(request.limit)
        ? Math.min(500, Math.max(1, request.limit))
        : 200;
    const query = new URLSearchParams({
      after: String(after),
      limit: String(limit),
    });
    return {
      method: "GET",
      path: `${root}/runs/${runId}/events?${query}`,
    };
  }
  throw new Error(`Unsupported world simulation operation: ${operation}`);
}

function upstreamError(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  return fallback;
}

export async function handleWorkbenchSimulationRoute(
  pathname: string,
  request: Request,
  options: RouteOptions = {},
): Promise<Response | null> {
  if (
    pathname !== "/api/workbench-simulation/request" ||
    request.method !== "POST"
  ) {
    return null;
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse(
      { success: false, error: "世界推演请求超过 2 MB 限制。" },
      413,
    );
  }

  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
      return jsonResponse(
        { success: false, error: "世界推演请求超过 2 MB 限制。" },
        413,
      );
    }
    const payload: unknown = JSON.parse(raw);
    if (!isRecord(payload)) throw new Error("Request body must be an object.");
    const workspacePath = requireText(payload.workspacePath, "workspacePath");
    if (!isRecord(payload.request)) throw new Error("request is required.");

    const operation = parseOperation(payload.request);
    const projectId = await readWorkspaceProjectId(workspacePath);
    if (operation.method === "GET" && operation.path.includes("/runs?")) {
      const requestedProjectId = new URLSearchParams(
        operation.path.split("?", 2)[1],
      ).get("projectId");
      if (requestedProjectId !== projectId) {
        throw new Error("projectId does not belong to workspacePath.");
      }
    }
    if (operation.method === "POST" && operation.path.endsWith("/runs")) {
      const snapshot =
        isRecord(operation.body) && isRecord(operation.body.snapshot)
          ? operation.body.snapshot
          : null;
      if (snapshot?.projectId !== projectId) {
        throw new Error("snapshot projectId does not belong to workspacePath.");
      }
    }
    const baseUrl = resolveMiroFishBaseUrl(
      options.baseUrl ?? process.env.MIROFISH_BASE_URL,
    );
    if (!options.fetchImpl) {
      await ensureMiroFishCompanion(baseUrl);
    }
    const target = new URL(operation.path, baseUrl);
    const modelProxyUrl =
      options.modelProxyUrl ??
      process.env.MYAGENTS_MODEL_PROXY_URL ??
      (process.env.MYAGENTS_PORT
        ? `http://127.0.0.1:${process.env.MYAGENTS_PORT}/api/workbench-ai/run`
        : undefined);
    const apiSecretKey =
      options.apiSecretKey ?? process.env.MIROFISH_API_SECRET_KEY ?? "";
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-MyAgents-Project-Id": projectId,
      "X-MyAgents-Workspace-Path": encodeURIComponent(resolve(workspacePath)),
    };
    if (apiSecretKey) headers["X-API-Key"] = apiSecretKey;
    if (operation.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const fetchImpl = options.fetchImpl ?? cancellableFetch;
    const upstream = await fetchImpl(
      target.toString(),
      {
        method: operation.method,
        headers,
        body:
          operation.body === undefined
            ? undefined
            : JSON.stringify(
                operation.method === "POST" && operation.path.endsWith("/runs")
                  ? {
                      ...(isRecord(operation.body) ? operation.body : {}),
                      workspacePath,
                      ...(modelProxyUrl
                        ? {
                            modelProxyUrl: resolveLoopbackUrl(
                              modelProxyUrl,
                              "modelProxyUrl",
                            ).toString(),
                          }
                        : {}),
                    }
                  : operation.body,
              ),
      },
      { parentSignal: request.signal, timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const responseText = await upstream.text();
    if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
      return jsonResponse(
        { success: false, error: "MiroFish 返回的数据超过 8 MB 限制。" },
        502,
      );
    }
    let responsePayload: unknown = {};
    if (responseText) {
      try {
        responsePayload = JSON.parse(responseText);
      } catch {
        return jsonResponse(
          { success: false, error: "MiroFish 返回了无效的 JSON。" },
          502,
        );
      }
    }
    if (!upstream.ok || !isRecord(responsePayload) || responsePayload.success !== true) {
      const message = upstreamError(
        responsePayload,
        `MiroFish 请求失败（HTTP ${upstream.status}）。`,
      );
      return jsonResponse({ success: false, error: message }, upstream.status || 502);
    }
    return jsonResponse({ success: true, data: responsePayload.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /required|invalid|unsupported|must be|request body|unexpected token|workspacePath|projectId|snapshot/iu.test(
        message,
      )
    ) {
      return jsonResponse({ success: false, error: message }, 400);
    }
    const timedOut = error instanceof Error && error.name === "AbortError";
    return jsonResponse(
      {
        success: false,
        error: timedOut
          ? "连接 MiroFish 超时，请确认世界推演伴随服务正在运行。"
          : `无法连接 MiroFish 世界推演服务：${message}。请启动本机 5103 端口的伴随服务。`,
      },
      timedOut ? 504 : 503,
    );
  }
}
