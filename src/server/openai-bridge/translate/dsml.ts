import type { OpenAIToolCall } from "../types/openai";

export const DSML_TOOL_CALLS_START = "<|DSML|tool_calls>";
export const DSML_TOOL_CALLS_START_FULLWIDTH = "<｜DSML｜tool_calls>";
export const DSML_TOOL_CALLS_STARTS = [
  DSML_TOOL_CALLS_START,
  DSML_TOOL_CALLS_START_FULLWIDTH,
] as const;
export const DSML_PARSE_ERROR_TEXT =
  "模型返回的工具调用协议不完整，本次对应操作未执行。请重试，或切换到支持标准工具调用的模型。";

export type DsmlToolCallParseResult =
  | { readonly kind: "not-dsml" }
  | { readonly kind: "parsed"; readonly toolCalls: readonly OpenAIToolCall[] }
  | { readonly kind: "malformed"; readonly error: string };

const DSML_START_PATTERN = /^<([|｜])DSML\1tool_calls>/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function isDsmlToolCallsStart(value: string): boolean {
  return DSML_TOOL_CALLS_STARTS.some((start) => value.startsWith(start));
}

export function isPossibleDsmlToolCallsStart(value: string): boolean {
  return (
    value.length > 0 &&
    DSML_TOOL_CALLS_STARTS.some(
      (start) => start.startsWith(value) || value.startsWith(start),
    )
  );
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parameterValue(raw: string, stringFlag: string | undefined): unknown {
  const value = decodeEntities(raw.trim());
  if (stringFlag === "true") return value;
  if (stringFlag === "false") return JSON.parse(value);
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function onlyWhitespace(value: string): boolean {
  return value.trim().length === 0;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function toolCallSignature(toolCall: OpenAIToolCall): string | null {
  try {
    return `${toolCall.function.name}\0${JSON.stringify(
      canonicalizeJson(JSON.parse(toolCall.function.arguments)),
    )}`;
  } catch {
    return null;
  }
}

export function excludeEquivalentToolCalls(
  candidates: readonly OpenAIToolCall[],
  existing: readonly OpenAIToolCall[],
): OpenAIToolCall[] {
  const signatures = new Set(
    existing
      .map(toolCallSignature)
      .filter((signature): signature is string => signature !== null),
  );
  return candidates.filter((candidate) => {
    const signature = toolCallSignature(candidate);
    if (signature === null || !signatures.has(signature)) {
      if (signature !== null) signatures.add(signature);
      return true;
    }
    return false;
  });
}

export function parseDsmlToolCalls(content: string): DsmlToolCallParseResult {
  const trimmed = content.trim();
  const startMatch = trimmed.match(DSML_START_PATTERN);
  if (!startMatch) {
    return { kind: "not-dsml" };
  }
  const marker = startMatch[1] ?? "|";
  const escapedMarker = escapeRegExp(marker);
  const toolCallsEnd = `</${marker}DSML${marker}tool_calls>`;
  const invokePattern = new RegExp(
    `<${escapedMarker}DSML${escapedMarker}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\/${escapedMarker}DSML${escapedMarker}invoke>`,
    "gu",
  );
  const parameterPattern = new RegExp(
    `<${escapedMarker}DSML${escapedMarker}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)<\\/${escapedMarker}DSML${escapedMarker}parameter>`,
    "gu",
  );
  if (!trimmed.endsWith(toolCallsEnd)) {
    return { kind: "malformed", error: "缺少 tool_calls 结束标记" };
  }
  const body = trimmed.slice(
    startMatch[0].length,
    trimmed.length - toolCallsEnd.length,
  );
  const toolCalls: OpenAIToolCall[] = [];
  let invokeCursor = 0;
  for (const invoke of body.matchAll(invokePattern)) {
    const index = invoke.index ?? 0;
    if (!onlyWhitespace(body.slice(invokeCursor, index))) {
      return { kind: "malformed", error: "invoke 之间包含无法识别的内容" };
    }
    const name = invoke[1]?.trim() ?? "";
    const parameterBody = invoke[2] ?? "";
    if (!name) return { kind: "malformed", error: "工具名称为空" };
    const input: Record<string, unknown> = {};
    let parameterCursor = 0;
    try {
      for (const parameter of parameterBody.matchAll(parameterPattern)) {
        const parameterIndex = parameter.index ?? 0;
        if (!onlyWhitespace(parameterBody.slice(parameterCursor, parameterIndex))) {
          return {
            kind: "malformed",
            error: `工具 ${name} 的参数之间包含无法识别的内容`,
          };
        }
        const parameterName = parameter[1]?.trim() ?? "";
        if (!parameterName) {
          return { kind: "malformed", error: `工具 ${name} 包含空参数名` };
        }
        if (Object.hasOwn(input, parameterName)) {
          return {
            kind: "malformed",
            error: `工具 ${name} 的参数 ${parameterName} 重复`,
          };
        }
        input[parameterName] = parameterValue(parameter[3] ?? "", parameter[2]);
        parameterCursor = parameterIndex + parameter[0].length;
      }
    } catch (error) {
      return {
        kind: "malformed",
        error: `工具 ${name} 的 JSON 参数无效：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!onlyWhitespace(parameterBody.slice(parameterCursor))) {
      return {
        kind: "malformed",
        error: `工具 ${name} 包含未闭合或无法识别的参数`,
      };
    }
    toolCalls.push({
      id: "",
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    });
    invokeCursor = index + invoke[0].length;
  }
  if (!onlyWhitespace(body.slice(invokeCursor))) {
    return { kind: "malformed", error: "包含未闭合或无法识别的 invoke" };
  }
  if (toolCalls.length === 0) {
    return { kind: "malformed", error: "没有找到工具调用" };
  }
  return { kind: "parsed", toolCalls };
}
