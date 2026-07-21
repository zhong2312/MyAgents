import type { McpServerDefinition } from "../../shared/config-types";
import { normalizeOfficialToolIds } from "../../shared/official-tools";
import { getSessionEngine } from "../session-engine";
import type {
  PermissionMode,
  ProviderEnv,
  SessionEngineSnapshotMaterializePatch,
} from "../session-engine/types";
import type { InteractionScenario } from "../system-prompt";
import {
  configureNovelWorkbenchToolset,
  getNovelWorkbenchContext,
  getNovelWorkbenchToolsetSnapshot,
  NOVEL_WORKBENCH_TOOLSET_ID,
} from "../novel-workbench-context";
import {
  ensureSdkMcpInSync,
  forceReloadActiveSession,
} from "../agent-session";
import {
  getSessionMetadata,
  updateSessionMetadata,
} from "../SessionStore";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redactSessionMetadata<T>(metadata: T): T {
  if (!metadata || typeof metadata !== "object") return metadata;
  const meta = metadata as T & { providerEnvJson?: unknown };
  if (meta.providerEnvJson === undefined) return metadata;
  return { ...meta, providerEnvJson: "[redacted]" };
}

function parseDesktopInteractionScenario(
  value: unknown,
): Extract<InteractionScenario, { type: "desktop" }> | null {
  if (!value || typeof value !== "object") return null;
  const scenario = value as { type?: unknown; surface?: unknown };
  if (scenario.type !== "desktop") return null;
  if (scenario.surface === undefined) return { type: "desktop" };
  if (scenario.surface === "chat" || scenario.surface === "floating-ball") {
    return { type: "desktop", surface: scenario.surface };
  }
  return null;
}

export async function handleSessionConfigRoute(
  pathname: string,
  request: Request,
): Promise<Response | null> {
  if (
    pathname === "/api/interaction-scenario/set" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as { scenario?: unknown };
      const scenario = parseDesktopInteractionScenario(payload?.scenario);
      if (!scenario) {
        return jsonResponse(
          { success: false, error: "Invalid desktop interaction scenario." },
          400,
        );
      }
      const result =
        await getSessionEngine().updateDesktopInteractionScenario(scenario);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error("[api/interaction-scenario/set] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to set interaction scenario",
        },
        500,
      );
    }
  }

  if (pathname === "/api/mcp/set" && request.method === "POST") {
    try {
      const payload = (await request.json()) as {
        servers?: McpServerDefinition[];
      };
      const servers = payload?.servers ?? [];
      const result = await getSessionEngine().updateMcpServers(servers);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error("[api/mcp/set] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to set MCP servers",
        },
        500,
      );
    }
  }

  if (
    pathname === "/api/workbench-agent/configure" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        toolset?: { id?: unknown; context?: unknown };
      };
      if (payload.toolset?.id !== NOVEL_WORKBENCH_TOOLSET_ID) {
        return jsonResponse(
          { success: false, error: "Unknown workbench Agent toolset." },
          400,
        );
      }
      const engine = getSessionEngine();
      if (engine.kind !== "builtin") {
        return jsonResponse(
          {
            success: false,
            error:
              "Controlled workbench tools currently require the builtin runtime.",
          },
          400,
        );
      }
      const activeSession = engine.getCurrentSessionContext();
      const workspace = activeSession.workspacePath?.trim();
      if (!workspace) {
        return jsonResponse(
          {
            success: false,
            error: "Agent session has no workspace path.",
          },
          409,
        );
      }
      const previousContext = getNovelWorkbenchContext();
      const boundSessionId = activeSession.sessionId?.trim() || "default";
      const context = configureNovelWorkbenchToolset(payload.toolset, {
        sessionId: boundSessionId,
        workspace,
      });
      const contextChanged =
        previousContext?.mode !== context.mode ||
        previousContext?.promptId !== context.promptId ||
        previousContext?.promptVersion !== context.promptVersion ||
        previousContext?.sessionId !== context.sessionId ||
        previousContext?.workspace !== context.workspace;
      const toolsetSnapshot = getNovelWorkbenchToolsetSnapshot();
      const existingMetadata = getSessionMetadata(boundSessionId);
      if (existingMetadata && toolsetSnapshot) {
        const updated = await updateSessionMetadata(boundSessionId, {
          workbenchToolset: toolsetSnapshot,
        });
        if (!updated) {
          throw new Error("Failed to persist workbench Agent toolset.");
        }
      }

      // Always verify the live Query, including when the in-memory context is
      // unchanged. A cold-resumed SDK process may have been created before the
      // renderer repeated this binding and therefore still lack the adapter.
      const toolsReady = await ensureSdkMcpInSync();
      if (!toolsReady) {
        // No live Query yet, or a turn currently owns it. The next Query is
        // rebuilt from the context already bound above.
        forceReloadActiveSession("mcp");
      }
      return jsonResponse({
        success: true,
        toolsetId: payload.toolset.id,
        mode: context.mode,
        persisted: Boolean(existingMetadata && toolsetSnapshot),
        toolsReady,
        contextChanged,
      });
    } catch (error) {
      console.error("[api/workbench-agent/configure] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to configure workbench Agent",
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/official-tools/session-enable" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as { enabledIds?: unknown };
      const ids =
        payload.enabledIds === null
          ? null
          : normalizeOfficialToolIds(payload.enabledIds);
      const result = await getSessionEngine().updateOfficialToolIds(ids);
      return jsonResponse(
        { ...result, enabledIds: ids },
        result.success ? 200 : 500,
      );
    } catch (error) {
      console.error("[api/official-tools/session-enable] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to set official tools",
        },
        500,
      );
    }
  }

  if (pathname === "/api/agents/set" && request.method === "POST") {
    try {
      const payload = (await request.json()) as {
        agents: Record<string, unknown>;
      };
      const result = await getSessionEngine().updateAgents(payload.agents);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error("[api/agents/set] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to set agents",
        },
        500,
      );
    }
  }

  if (pathname === "/api/provider/set" && request.method === "POST") {
    try {
      const payload = (await request.json()) as {
        providerEnv?: Record<string, unknown> | null;
      };
      const providerEnv = (payload?.providerEnv ?? undefined) as
        | ProviderEnv
        | undefined;
      const result = await getSessionEngine().updateProviderEnv(providerEnv);
      return jsonResponse(
        result.success ? { success: true } : result,
        result.success ? 200 : 500,
      );
    } catch (error) {
      console.error("[api/provider/set] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to set provider",
        },
        500,
      );
    }
  }

  if (
    pathname === "/api/session/permission-mode" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as { permissionMode?: string };
      if (!payload?.permissionMode) {
        return jsonResponse(
          { success: false, error: "permissionMode is required" },
          400,
        );
      }
      const result = await getSessionEngine().updatePermissionMode(
        payload.permissionMode as PermissionMode,
      );
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error("[api/session/permission-mode] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to set permission mode",
        },
        500,
      );
    }
  }

  if (pathname === "/api/session/materialize" && request.method === "POST") {
    try {
      const payload = (await request.json()) as {
        workspacePath?: string;
        phase?: "prepare" | "commit" | "rollback";
        preparedSessionId?: string;
        snapshotPatch?: SessionEngineSnapshotMaterializePatch;
      };
      if (
        !payload?.workspacePath ||
        typeof payload.workspacePath !== "string"
      ) {
        return jsonResponse(
          { success: false, error: "workspacePath is required" },
          400,
        );
      }
      const result = await getSessionEngine().materializePendingDesktopSession({
        workspacePath: payload.workspacePath,
        phase: payload.phase,
        preparedSessionId: payload.preparedSessionId,
        snapshotPatch: payload.snapshotPatch,
      });
      return jsonResponse(
        result.metadata
          ? { ...result, metadata: redactSessionMetadata(result.metadata) }
          : result,
        result.success ? 200 : (result.status ?? 500),
      );
    } catch (error) {
      console.error("[api/session/materialize] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to materialize session",
        },
        500,
      );
    }
  }

  if (pathname === "/api/session/config" && request.method === "GET") {
    try {
      return jsonResponse(getSessionEngine().getSessionConfigSnapshot());
    } catch (error) {
      console.error("[api/session/config] Error:", error);
      return jsonResponse(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get session config",
        },
        500,
      );
    }
  }

  return null;
}
