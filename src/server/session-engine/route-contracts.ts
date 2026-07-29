export type SessionEngineRouteContract = {
  path: string;
  method: "GET" | "POST";
  engineMethod: string;
  requiredFields?: string[];
  responseKeys: string[];
  failureStatuses: number[];
  behavior: string;
};

export const SESSION_ENGINE_ROUTE_CONTRACTS: SessionEngineRouteContract[] = [
  {
    path: "/chat/send",
    method: "POST",
    engineMethod: "sendDesktopMessage",
    responseKeys: [
      "success",
      "queued",
      "queueId",
      "isInFlight",
      "deliveryMode",
    ],
    failureStatuses: [400, 429, 500],
    behavior:
      "Desktop admission returns before external runtime dispatch completes.",
  },
  {
    path: "/chat/stop",
    method: "POST",
    engineMethod: "stopTurn",
    responseKeys: ["success", "alreadyStopped"],
    failureStatuses: [500],
    behavior:
      "Stops active external process or builtin turn; external-inactive keeps builtin fallback.",
  },
  {
    path: "/api/goal/objective",
    method: "POST",
    engineMethod: "updateObjective (Goal orchestrator)",
    requiredFields: ["objective"],
    responseKeys: ["success", "goal", "delivery", "error"],
    failureStatuses: [400, 408, 409, 500, 503],
    behavior:
      "Persists through the Rust Goal owner, steers capable active turns, and otherwise stops at a turn boundary before restarting.",
  },
  {
    path: "/chat/reset",
    method: "POST",
    engineMethod: "resetForNewDesktopSession",
    responseKeys: ["success", "sessionId", "error"],
    failureStatuses: [500],
    behavior:
      "Starts a new desktop conversation through the active engine; external owns subprocess cleanup.",
  },
  {
    path: "/chat/rewind",
    method: "POST",
    engineMethod: "rewindToUserMessage",
    requiredFields: ["userMessageId"],
    responseKeys: ["success", "content", "attachments", "error"],
    failureStatuses: [400],
    behavior:
      "Rewinds builtin sessions through the engine; external runtimes return an unsupported capability error.",
  },
  {
    path: "/chat/external-retry",
    method: "POST",
    engineMethod: "retryLastExternalUserMessage",
    requiredFields: ["userMessageId"],
    responseKeys: ["success", "content", "attachments", "error"],
    failureStatuses: [400],
    behavior:
      "Retries the latest external user message through the external engine; builtin returns an unsupported capability error.",
  },
  {
    path: "/chat/stream",
    method: "GET",
    engineMethod: "getStreamReplaySnapshot",
    responseKeys: [
      "chat:init",
      "chat:message-replay",
      "chat:logs",
      "chat:system-init",
    ],
    failureStatuses: [],
    behavior:
      "Initial SSE replay comes from the active engine snapshot; SSE disconnect remains non-cancelling.",
  },
  {
    path: "/chat/queue/cancel",
    method: "POST",
    engineMethod: "cancelQueuedMessage",
    requiredFields: ["queueId"],
    responseKeys: ["success", "cancelledText", "error"],
    failureStatuses: [400, 404, 409, 500, 503],
    behavior:
      "Cancels queued messages in the active engine without touching completed turns.",
  },
  {
    path: "/chat/queue/force",
    method: "POST",
    engineMethod: "forceQueuedMessage",
    requiredFields: ["queueId"],
    responseKeys: ["success", "error"],
    failureStatuses: [400, 404, 500],
    behavior:
      "Interrupts current turn and promotes the queued item for the active engine.",
  },
  {
    path: "/chat/queue/status",
    method: "GET",
    engineMethod: "getQueueStatus",
    responseKeys: ["success", "queue"],
    failureStatuses: [],
    behavior: "Reports the active engine queue snapshot.",
  },
  {
    path: "/cron/execute-sync",
    method: "POST",
    engineMethod: "runInjectedTurn",
    requiredFields: ["taskId", "prompt"],
    responseKeys: [
      "success",
      "aiRequestedExit",
      "exitReason",
      "outputText",
      "sessionId",
      "error",
    ],
    failureStatuses: [400, 408, 409, 500, 503],
    behavior:
      "Authorizes and settles Session metadata birth before runtime dispatch, then gates completion on the active engine success signal; managed memory jobs also require their exact official system skill at the Runtime dispatch boundary.",
  },
  {
    path: "/task/stop",
    method: "POST",
    engineMethod: "stopOwnedTurnByQueueId",
    requiredFields: ["taskId", "queueId"],
    responseKeys: ["success", "alreadyStopped", "error"],
    failureStatuses: [400, 500],
    behavior:
      "Stops only the exact current or queued Task turn without affecting a later run or other Session work; a not-found success waits for any pre-metadata creator request to settle.",
  },
  {
    path: "/goal/execute-sync",
    method: "POST",
    engineMethod: "runInjectedTurn",
    requiredFields: [
      "goalId",
      "objective",
      "sessionId",
      "queueId",
      "expectedControlRevision",
    ],
    responseKeys: [
      "success",
      "outputText",
      "sessionId",
      "goalChannelDeliveryExpected",
      "error",
    ],
    failureStatuses: [400, 408, 409, 500, 503],
    behavior:
      "Claims the supplied queue turn at a clean boundary and waits for true engine completion.",
  },
  {
    path: "/api/im/enqueue",
    method: "POST",
    engineMethod: "enqueueImMessage",
    requiredFields: ["requestId"],
    responseKeys: ["success", "requestId", "accepted", "sessionId", "error"],
    failureStatuses: [400, 500, 503],
    behavior:
      "Accepts an IM message synchronously without waiting for the assistant turn.",
  },
  {
    path: "/api/im/cancel",
    method: "POST",
    engineMethod: "cancelImRequest",
    requiredFields: ["requestId"],
    responseKeys: ["success", "requestId", "mode", "error"],
    failureStatuses: [400, 404, 409, 500],
    behavior:
      "Cancels an IM request by requestId while keeping registry and bus cleanup in the route.",
  },
  {
    path: "/api/im/heartbeat",
    method: "POST",
    engineMethod: "runInjectedTurn",
    requiredFields: ["prompt", "source", "sourceId"],
    responseKeys: ["status", "text", "reason", "messageEnqueued"],
    failureStatuses: [200, 500],
    behavior:
      "Runs a synchronous heartbeat turn, forwards Router-owned metadataBirthPending, exposes the engine enqueue acknowledgement as messageEnqueued, and lets the route own event drain/requeue semantics; runtime failures are body-level status values on HTTP 200 unless parsing/handler throws.",
  },
  {
    path: "/api/memory/update",
    method: "POST",
    engineMethod: "runInjectedTurn",
    requiredFields: ["source"],
    responseKeys: ["status", "reason"],
    failureStatuses: [200, 500],
    behavior:
      "Injects memory maintenance through the active engine and gates completion on true turn success; manual and automatic turns both require the exact official myagents-memory-update skill at the Runtime dispatch boundary, managed auto-update carries exact Task queue ownership for authorization and stop, and timeout/turn_failed remain body-level status values on HTTP 200.",
  },
  {
    path: "/api/inbox/drain",
    method: "POST",
    engineMethod: "enqueueInboxMessage",
    requiredFields: ["messages"],
    responseKeys: ["accepted", "reason"],
    failureStatuses: [400, 409, 500],
    behavior:
      "Audited injection path for sidecar-to-sidecar session events; does not wait for turn completion.",
  },
  {
    path: "/api/model/set",
    method: "POST",
    engineMethod: "updateModel",
    requiredFields: ["model"],
    responseKeys: ["success", "error"],
    failureStatuses: [400, 500],
    behavior:
      "Updates active engine model; active engine preserves imConfigSync snapshot guard.",
  },
  {
    path: "/api/reasoning-effort/set",
    method: "POST",
    engineMethod: "updateReasoningEffort",
    requiredFields: ["effort"],
    responseKeys: ["success", "error"],
    failureStatuses: [400, 500],
    behavior: "Updates active engine reasoning effort.",
  },
  {
    path: "/api/session/permission-mode",
    method: "POST",
    engineMethod: "updatePermissionMode",
    requiredFields: ["permissionMode"],
    responseKeys: ["success", "error"],
    failureStatuses: [400, 500],
    behavior: "Updates active engine permission mode.",
  },
  {
    path: "/api/session/materialize",
    method: "POST",
    engineMethod: "materializePendingDesktopSession",
    requiredFields: ["workspacePath"],
    responseKeys: ["success", "sessionId", "metadata", "error"],
    failureStatuses: [400, 409, 500],
    behavior:
      "Materializes a pending desktop session before required snapshot writes, using the active engine owner.",
  },
  {
    path: "/api/session/config",
    method: "GET",
    engineMethod: "getSessionConfigSnapshot",
    responseKeys: [
      "success",
      "runtime",
      "model",
      "mcpServerIds",
      "agentNames",
      "permissionMode",
      "reasoningEffort",
    ],
    failureStatuses: [500],
    behavior:
      "Reads the active engine configuration snapshot without route-level runtime branching.",
  },
  {
    path: "/api/session-state",
    method: "GET",
    engineMethod: "getLiveSessionState",
    responseKeys: ["sessionState"],
    failureStatuses: [],
    behavior: "Reads the live state from the active engine.",
  },
  {
    path: "/api/session-latest-result",
    method: "GET",
    engineMethod: "getLatestAssistantResult",
    responseKeys: ["sessionId", "latestResult"],
    failureStatuses: [],
    behavior:
      "Reads the latest assistant result from the active engine with runtime-specific fallback hidden in adapters.",
  },
  {
    path: "/api/session-watch/register",
    method: "POST",
    engineMethod:
      "getRuntimeIdentity/getLiveSessionState/getLatestAssistantResult",
    requiredFields: ["watchId", "watcherSessionId", "targetSessionId"],
    responseKeys: ["accepted", "delivery", "reason", "pending", "latestResult"],
    failureStatuses: [400, 409],
    behavior:
      "Registers session watches against the active engine identity and state.",
  },
  {
    path: "/sessions/:id",
    method: "GET",
    engineMethod: "getLiveSessionOverlay",
    responseKeys: ["success", "session", "error"],
    failureStatuses: [400, 404],
    behavior:
      "Merges persisted session history with active engine live overlay for the requested session.",
  },
  {
    path: "/sessions/fork",
    method: "POST",
    engineMethod: "forkAtAssistantMessage",
    requiredFields: ["messageId"],
    responseKeys: ["success", "newSessionId", "agentDir", "title", "error"],
    failureStatuses: [400],
    behavior:
      "Forks builtin sessions through the engine; external runtimes return an unsupported capability error.",
  },
  {
    path: "/sessions/switch",
    method: "POST",
    engineMethod: "switchToExistingSession",
    requiredFields: ["sessionId"],
    responseKeys: ["success", "sessionId", "error"],
    failureStatuses: [400, 404, 409, 500],
    behavior:
      "Switches the active engine to an existing session; external validates persisted runtime before binding.",
  },
  {
    path: "/api/im/session/new",
    method: "POST",
    engineMethod: "resetForNewImSession",
    responseKeys: ["sessionId", "success", "error"],
    failureStatuses: [500],
    behavior:
      "Creates a new published IM session through the active engine; external owns stop/rebind sequencing.",
  },
  {
    path: "/api/interaction-scenario/set",
    method: "POST",
    engineMethod: "updateDesktopInteractionScenario",
    requiredFields: ["scenario"],
    responseKeys: ["success", "skipped", "error"],
    failureStatuses: [400, 500],
    behavior:
      "Applies desktop interaction scenario only where the active engine supports it.",
  },
  {
    path: "/api/mcp/set",
    method: "POST",
    engineMethod: "updateMcpServers",
    responseKeys: ["success", "servers", "skipped", "error"],
    failureStatuses: [500],
    behavior:
      "Applies builtin MCP overrides through the engine; external runtimes explicitly skip route-level mutation.",
  },
  {
    path: "/api/workbench-agent/configure",
    method: "POST",
    engineMethod: "configureWorkbenchToolset",
    requiredFields: ["toolset"],
    responseKeys: ["success", "toolsetId", "mode", "error"],
    failureStatuses: [400],
    behavior:
      "Binds a recognized controlled workbench toolset before the builtin MCP fingerprint is rebuilt.",
  },
  {
    path: "/api/official-tools/session-enable",
    method: "POST",
    engineMethod: "updateOfficialToolIds",
    responseKeys: ["success", "enabledIds", "skipped", "error"],
    failureStatuses: [500],
    behavior:
      "Applies per-session MyAgents official CLI tool selections through the active engine; prompt-changing external runtimes persist metadata and drop idle/prewarm processes.",
  },
  {
    path: "/api/agents/set",
    method: "POST",
    engineMethod: "updateAgents",
    responseKeys: ["success", "skipped", "error"],
    failureStatuses: [500],
    behavior:
      "Applies builtin agent overrides through the engine; external runtimes explicitly skip route-level mutation.",
  },
  {
    path: "/api/provider/set",
    method: "POST",
    engineMethod: "updateProviderEnv",
    responseKeys: ["success", "error"],
    failureStatuses: [500],
    behavior:
      "Applies provider env through the engine while preserving the legacy success-only route response.",
  },
  {
    path: "/api/runtime/config",
    method: "POST",
    engineMethod: "updateRuntimeConfig",
    responseKeys: ["success", "error", "skipped"],
    failureStatuses: [400, 500],
    behavior:
      "Applies external runtime config only; source-aware snapshot guard preserves desktop-owned external sessions; builtin returns a 400-compatible error.",
  },
  {
    path: "/api/runtime/prewarm",
    method: "POST",
    engineMethod: "prewarm",
    responseKeys: ["success", "error"],
    failureStatuses: [400, 500],
    behavior: "Pre-warms external runtimes only.",
  },
  {
    path: "/api/runtime/permission-response",
    method: "POST",
    engineMethod: "respondPermission",
    requiredFields: ["requestId"],
    responseKeys: ["success", "error"],
    failureStatuses: [400, 500],
    behavior:
      "Responds to runtime permission requests through the active permission-response engine, preserving builtin fallback when no external process is active.",
  },
  {
    path: "/api/permission/respond",
    method: "POST",
    engineMethod: "respondPermission",
    requiredFields: ["requestId"],
    responseKeys: ["success", "error"],
    failureStatuses: [500],
    behavior:
      "Responds to builtin/external permission requests through the active engine.",
  },
  {
    path: "/api/im/permission-response",
    method: "POST",
    engineMethod: "respondPermission",
    requiredFields: ["requestId"],
    responseKeys: ["success", "error"],
    failureStatuses: [500],
    behavior:
      "Responds to IM approval-card permission requests through the active engine.",
  },
  {
    path: "/api/ask-user-question/respond",
    method: "POST",
    engineMethod: "respondAskUserQuestion",
    requiredFields: ["requestId"],
    responseKeys: ["success", "error"],
    failureStatuses: [500],
    behavior:
      "Routes ask-user-question responses by pending request ownership.",
  },
];

export function findSessionEngineRouteContract(
  path: string,
  method: string,
): SessionEngineRouteContract | undefined {
  return SESSION_ENGINE_ROUTE_CONTRACTS.find(
    (contract) => contract.path === path && contract.method === method,
  );
}
