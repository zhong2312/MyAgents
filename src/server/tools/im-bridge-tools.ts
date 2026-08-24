// IM Bot Bridge Tools — one Session-stable MCP surface backed by OpenClaw.
// Tool schema discovery belongs to the surface generation; sender/chat/account
// identity belongs to the active turn and is resolved only when a tool runs.

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type {
  ImBridgeToolSurface,
  ImBridgeTurnContext,
} from '../session-core/im-bridge-types';
import { MCP_PREWARM_GRACE_MS } from '../session-core/mcp-prewarm-policy';
import { MYAGENTS_TOOL_CALL_TIMEOUT_MS } from '../session-core/tool-call-policy';
import { isBridgeAskUserQuestionTool } from '../host-interaction';
import { cancellableFetch } from '../utils/cancellation';
import { maybeSpill } from '../utils/large-value-store';
import { getCurrentTurnSignal } from '../utils/turn-abort';

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ResolveTurnContext = () => ImBridgeTurnContext | null;

type ImBridgeSurfaceState = 'initializing' | 'ready' | 'degraded';

type ImBridgeSurfaceOwner = {
  identity: string;
  generation: number;
  surface: ImBridgeToolSurface;
  startedAt: number;
  deadlineAt: number;
  state: ImBridgeSurfaceState;
  server: McpSdkServerConfigWithInstance | null;
  initialization: Promise<void>;
};

export type ImBridgeSurfaceEnsureResult = {
  /** The desired SDK MCP map may have changed and should be synchronized once. */
  changed: boolean;
  generation: number;
  state: Exclude<ImBridgeSurfaceState, 'initializing'>;
  startedAt: number;
  deadlineAt: number;
};

let surfaceOwner: ImBridgeSurfaceOwner | null = null;
let nextSurfaceGeneration = 0;

export function normalizeImBridgeToolSurface(surface: ImBridgeToolSurface): ImBridgeToolSurface {
  return {
    bridgePort: surface.bridgePort,
    pluginId: surface.pluginId,
    enabledToolGroups: [...new Set([...surface.enabledToolGroups, 'interaction'])].sort(),
  };
}

export function imBridgeToolSurfaceIdentity(surface: ImBridgeToolSurface): string {
  const normalized = normalizeImBridgeToolSurface(surface);
  return JSON.stringify([
    normalized.bridgePort,
    normalized.pluginId,
    normalized.enabledToolGroups,
  ]);
}

/** Trigger the plugin's feishu_auth command for the active turn identity. */
async function triggerAutoAuth(
  surface: ImBridgeToolSurface,
  turnContext: ImBridgeTurnContext,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  console.log('[im-bridge-tools] need_user_authorization detected, triggering auto-auth via feishu_auth command');
  try {
    const resp = await cancellableFetch(
      `http://127.0.0.1:${surface.bridgePort}/execute-command`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'feishu_auth',
          args: '',
          userId: turnContext.senderId || '',
          chatId: turnContext.chatId || '',
        }),
      },
      { timeoutMs: 15_000, parentSignal: signal ?? getCurrentTurnSignal() },
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(`[im-bridge-tools] Auto-auth command failed (${resp.status}): ${errText}`);
      return {
        content: [{ type: 'text', text: `该操作需要用户授权飞书权限。自动发送授权卡片失败 (${resp.status})，请用户使用 /feishu_auth 命令手动授权后重试。` }],
        isError: true,
      };
    }
    const result = await resp.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (result && !result.ok) {
      console.warn(`[im-bridge-tools] Auto-auth command returned error: ${result.error}`);
      return {
        content: [{ type: 'text', text: `该操作需要用户授权飞书权限。授权流程出错: ${result.error || 'unknown'}，请用户使用 /feishu_auth 命令手动授权后重试。` }],
        isError: true,
      };
    }
  } catch (error) {
    console.warn('[im-bridge-tools] Auto-auth request failed:', error);
    return {
      content: [{ type: 'text', text: '该操作需要用户授权飞书权限。自动授权请求失败，请用户使用 /feishu_auth 命令手动授权后重试。' }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: '该操作需要用户授权飞书权限。已自动发送授权卡片，请用户在飞书中点击"前往授权"完成授权后重试。' }],
  };
}

async function callBridgeTool(params: {
  surface: ImBridgeToolSurface;
  resolveTurnContext: ResolveTurnContext;
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<CallToolResult> {
  const turnContext = params.resolveTurnContext();
  if (!turnContext) {
    return {
      content: [{ type: 'text', text: 'Error: IM Bridge tool called outside an active IM turn' }],
      isError: true,
    };
  }

  try {
    const callResp = await cancellableFetch(
      `http://127.0.0.1:${params.surface.bridgePort}/mcp/call-tool`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolName: params.toolName,
          args: params.args,
          userId: turnContext.senderId,
          isOwner: turnContext.isOwner ?? false,
          enabledGroups: params.surface.enabledToolGroups,
          chatId: turnContext.chatId,
          chatType: turnContext.sourceType === 'group' ? 'group' : 'p2p',
          accountId: turnContext.accountId,
        }),
      },
      {
        timeoutMs: MYAGENTS_TOOL_CALL_TIMEOUT_MS,
        parentSignal: params.signal ?? getCurrentTurnSignal(),
      },
    );

    if (!callResp.ok) {
      const text = await callResp.text();
      return {
        content: [{ type: 'text', text: `Tool call failed (${callResp.status}): ${text}` }],
        isError: true,
      };
    }

    const callBody = await callResp.text();
    const callContentType = callResp.headers.get('content-type') ?? '';
    if (!callContentType.includes('application/json')) {
      return {
        content: [{ type: 'text', text: `Tool returned non-JSON response (ct=${callContentType}): ${callBody.slice(0, 500)}` }],
        isError: true,
      };
    }

    let result: { ok: boolean; result?: unknown; error?: string };
    try {
      result = JSON.parse(callBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Tool returned malformed JSON: ${message}\n${callBody.slice(0, 500)}` }],
        isError: true,
      };
    }

    if (!result.ok) {
      if (result.error?.includes('need_user_authorization') && turnContext.chatId) {
        return triggerAutoAuth(params.surface, turnContext, params.signal);
      }
      return {
        content: [{ type: 'text', text: `Tool error: ${result.error || 'unknown'}` }],
        isError: true,
      };
    }

    const raw = result.result as Record<string, unknown> | string | null | undefined;
    let resultText: string;
    if (typeof raw === 'string') {
      resultText = raw;
    } else if (raw != null && Array.isArray(raw.content)) {
      const content = raw.content as Array<{ type: string; text?: string }>;
      resultText = content.map(item => item.text ?? '').join('\n') || 'OK (empty result)';
    } else if (raw != null) {
      resultText = JSON.stringify(raw, null, 2);
    } else {
      resultText = 'OK (no data returned)';
    }

    if (resultText.includes('need_user_authorization') && turnContext.chatId) {
      return triggerAutoAuth(params.surface, turnContext, params.signal);
    }

    const spilled = await maybeSpill(resultText, {
      mimetype: 'text/plain; charset=utf-8',
      sessionId: params.surface.pluginId,
    });
    if ('inline' in spilled) {
      return { content: [{ type: 'text', text: resultText }] };
    }
    return {
      content: [{
        type: 'text',
        text: `${spilled.preview}\n\n…(truncated; ${spilled.sizeBytes} bytes total) `
          + `@ref:${spilled.id} (mimetype=${spilled.mimetype})`,
      }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

function settleSurface(
  owner: ImBridgeSurfaceOwner,
  state: Exclude<ImBridgeSurfaceState, 'initializing'>,
  server: McpSdkServerConfigWithInstance | null,
  summary: string,
): void {
  if (surfaceOwner !== owner) return;
  owner.state = state;
  owner.server = server;
  console.log(
    `[im-bridge-tools] MCP pre-warm terminal outcome=${state} generation=${owner.generation}`
    + ` elapsedMs=${Date.now() - owner.startedAt} budgetMs=${MCP_PREWARM_GRACE_MS} ${summary}`,
  );
}

async function initializeSurface(
  owner: ImBridgeSurfaceOwner,
  resolveTurnContext: ResolveTurnContext,
): Promise<void> {
  try {
    const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod/v4');
    if (surfaceOwner !== owner) return;

    const remainingMs = owner.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      settleSurface(owner, 'degraded', null, 'reason=timeout-before-discovery');
      return;
    }

    const groups = owner.surface.enabledToolGroups.join(',');
    const url = `http://127.0.0.1:${owner.surface.bridgePort}/mcp/tools?groups=${groups}`;
    const response = await cancellableFetch(
      url,
      { headers: { 'Content-Type': 'application/json' } },
      { timeoutMs: remainingMs },
    );
    const bridgeBody = await response.text();
    const bridgeContentType = response.headers.get('content-type') ?? '';
    if (surfaceOwner !== owner) return;
    if (!response.ok || !bridgeContentType.includes('application/json')) {
      console.warn(`[im-bridge-tools] Bridge /mcp/tools ${response.status} (ct=${bridgeContentType}): ${bridgeBody.slice(0, 200)}`);
      settleSurface(owner, 'degraded', null, `reason=discovery-response status=${response.status}`);
      return;
    }

    let data: {
      ok: boolean;
      tools: Array<{ name: string; description: string; group: string; parameters: Record<string, unknown> }>;
    };
    try {
      data = JSON.parse(bridgeBody);
    } catch {
      console.warn(`[im-bridge-tools] Malformed JSON from /mcp/tools: ${bridgeBody.slice(0, 200)}`);
      settleSurface(owner, 'degraded', null, 'reason=malformed-discovery-json');
      return;
    }

    if (!data.ok || !Array.isArray(data.tools)) {
      settleSurface(owner, 'degraded', null, 'reason=discovery-error');
      return;
    }

    const pluginTools = data.tools.filter(pluginTool => {
      if (!pluginTool.name) return false;
      if (isBridgeAskUserQuestionTool(pluginTool.name)) {
        console.log(`[im-bridge-tools] Filtered unsupported bridge AskUserQuestion tool: ${pluginTool.name}`);
        return false;
      }
      return true;
    });
    if (pluginTools.length === 0) {
      settleSurface(owner, 'ready', null, 'tools=0');
      return;
    }

    const dynamicTools = pluginTools.map(pluginTool => tool(
      pluginTool.name,
      pluginTool.description || '',
      { args: z.record(z.string(), z.any()).describe('Tool arguments as key-value pairs') },
      async (params: { args: Record<string, unknown> }, extra: unknown) => callBridgeTool({
        surface: owner.surface,
        resolveTurnContext,
        toolName: pluginTool.name,
        args: params.args,
        signal: extra && typeof extra === 'object' && 'signal' in extra
          && (extra as { signal?: unknown }).signal instanceof AbortSignal
          ? (extra as { signal: AbortSignal }).signal
          : undefined,
      }),
    ));
    if (surfaceOwner !== owner) return;
    const server = createSdkMcpServer({
      name: 'im-bridge-tools',
      version: '1.0.0',
      tools: dynamicTools,
    });
    settleSurface(owner, 'ready', server, `tools=${pluginTools.length}`);
  } catch (error) {
    if (surfaceOwner !== owner) return;
    console.warn('[im-bridge-tools] Failed to create dynamic server:', error);
    settleSurface(owner, 'degraded', null, 'reason=discovery-failed');
  }
}

/**
 * Ensure one stable tool surface. The same identity shares initialization and
 * never retries per message, including after a degraded terminal outcome.
 */
export async function ensureImBridgeToolSurface(
  requestedSurface: ImBridgeToolSurface,
  resolveTurnContext: ResolveTurnContext,
): Promise<ImBridgeSurfaceEnsureResult> {
  const surface = normalizeImBridgeToolSurface(requestedSurface);
  const identity = imBridgeToolSurfaceIdentity(surface);
  const current = surfaceOwner;
  if (current?.identity === identity) {
    await current.initialization;
    return {
      changed: false,
      generation: current.generation,
      state: current.state as Exclude<ImBridgeSurfaceState, 'initializing'>,
      startedAt: current.startedAt,
      deadlineAt: current.deadlineAt,
    };
  }

  const startedAt = Date.now();
  const owner: ImBridgeSurfaceOwner = {
    identity,
    generation: ++nextSurfaceGeneration,
    surface,
    startedAt,
    deadlineAt: startedAt + MCP_PREWARM_GRACE_MS,
    state: 'initializing',
    server: null,
    initialization: Promise.resolve(),
  };
  surfaceOwner = owner;
  console.log(
    `[im-bridge-tools] Surface start generation=${owner.generation}`
    + ` bridge=${surface.bridgePort} plugin=${surface.pluginId} groups=${surface.enabledToolGroups.join(',')}`,
  );
  owner.initialization = initializeSurface(owner, resolveTurnContext);
  await owner.initialization;
  return {
    changed: surfaceOwner === owner,
    generation: owner.generation,
    state: owner.state as Exclude<ImBridgeSurfaceState, 'initializing'>,
    startedAt: owner.startedAt,
    deadlineAt: owner.deadlineAt,
  };
}

export function clearImBridgeToolsContext(): void {
  surfaceOwner = null;
  nextSurfaceGeneration += 1;
  console.log('[im-bridge-tools] Surface cleared');
}

export function getImBridgeToolSurface(): ImBridgeToolSurface | null {
  return surfaceOwner?.surface ?? null;
}

export function getImBridgeToolPrewarmWindow(): { startedAt: number; deadlineAt: number } | null {
  return surfaceOwner
    ? { startedAt: surfaceOwner.startedAt, deadlineAt: surfaceOwner.deadlineAt }
    : null;
}

export function getImBridgeToolServer(): McpSdkServerConfigWithInstance | null {
  return surfaceOwner?.server ?? null;
}
