import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CODEX_SUBSCRIPTION_PROVIDER_ID } from "../shared/config-types";
import { CUSTOM_EVENTS } from "../shared/constants";

const mocks = vi.hoisted(() => {
  const project = {
    id: "helper-project",
    name: "Novel",
    path: "/Users/me/.myagents",
    displayName: "MA Helper",
    agentId: "helper-agent",
    providerId: "stale-volcengine",
    permissionMode: null,
    workbenchId: "io.myagents.novel",
  };
  const agent = {
    id: "helper-agent",
    name: "MA Helper",
    workspacePath: project.path,
    runtime: "builtin",
    permissionMode: "auto",
    reasoningEffort: undefined as string | undefined,
    runtimeConfig: undefined as
      | { permissionMode?: string; reasoningEffort?: string }
      | undefined,
  };
  const provider = {
    id: "provider-1",
    name: "Provider",
    type: "openai-compatible",
    baseUrl: "https://example.com",
    primaryModel: "mimo-v2.5-pro",
    models: [{ id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" }],
  };

  return {
    project,
    agent,
    provider,
    multiAgentRuntime: false,
    resolveBuiltinSelection: vi.fn(
      (): { provider: typeof provider; model: string } | undefined => ({
        provider,
        model: "mimo-v2.5-pro",
      }),
    ),
    createSession: vi.fn(async () => ({
      id: "prepared-managed-session",
      agentDir: project.path,
      title: "Prepared",
      createdAt: "2026-06-27T00:00:00.000Z",
      lastActiveAt: "2026-06-27T00:00:00.000Z",
    })),
    getSessions: vi.fn(async () => [] as Array<Record<string, unknown>>),
    toast: {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    },
    startGlobalSidecar: vi.fn(async () => undefined),
    initGlobalSidecarReadyPromise: vi.fn(),
    markGlobalSidecarReady: vi.fn(),
    getGlobalServerUrl: vi.fn(async () => "http://127.0.0.1:31415"),
    ensureSessionSidecar: vi.fn(async () => ({ port: 31417, isNew: true })),
    activateSession: vi.fn(async () => undefined),
    releaseTabSession: vi.fn(async () => false),
    getSessionPort: vi.fn(async () => null),
    startBackgroundCompletion: vi.fn(async () => ({ started: false })),
    setAppActiveCorrelation: vi.fn(),
    setAppActiveTabId: vi.fn(),
    chatProps: [] as Array<Record<string, unknown>>,
    launcherProps: [] as Array<Record<string, unknown>>,
    workbenchShellProps: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@/analytics", () => ({
  initAnalytics: vi.fn(async () => undefined),
  track: vi.fn(),
  setAnalyticsContext: vi.fn(),
  clearAnalyticsContext: vi.fn(),
  setPendingSurface: vi.fn(),
  clearPendingSurface: vi.fn(),
  setPendingSessionBirth: vi.fn(),
  clearPendingSessionBirth: vi.fn(),
  birthContextForSurface: vi.fn((surface: string) => ({
    surface,
    entryIntent: surface === "new_chat_button" ? "new_chat" : "unknown",
    hasInitialMessage: surface !== "new_chat_button",
  })),
  hashAgentName: vi.fn(async () => "agent-hash"),
  hashAgentNameSync: vi.fn(() => "agent-hash"),
}));

vi.mock("@/api/tauriClient", () => ({
  stopTabSidecar: vi.fn(async () => undefined),
  setAppActiveCorrelation: mocks.setAppActiveCorrelation,
  startGlobalSidecar: mocks.startGlobalSidecar,
  initGlobalSidecarReadyPromise: mocks.initGlobalSidecarReadyPromise,
  markGlobalSidecarReady: mocks.markGlobalSidecarReady,
  getGlobalServerUrl: mocks.getGlobalServerUrl,
  getSessionActivation: vi.fn(async () => null),
  updateSessionTab: vi.fn(async () => undefined),
  ensureSessionSidecar: mocks.ensureSessionSidecar,
  releaseTabSession: mocks.releaseTabSession,
  activateSession: mocks.activateSession,
  upgradeSessionId: vi.fn(async () => true),
  getSessionPort: mocks.getSessionPort,
  hasSessionSidecar: vi.fn(async () => true),
  getSessionGeneration: vi.fn(async () => 1),
  stopSseProxy: vi.fn(async () => undefined),
  startBackgroundCompletion: mocks.startBackgroundCompletion,
  cancelBackgroundCompletion: vi.fn(async () => undefined),
  updateGlobalServerUrl: vi.fn(),
  canRestoreSession: vi.fn(async () => true),
  getUserSchedulerLifecycleSnapshot: vi.fn(async () => ({
    runningTaskCount: 0,
    protectedSessionIds: [],
  })),
  sessionHasPersistentOwners: vi.fn(async () => false),
}));

vi.mock("@/api/apiFetch", () => ({
  apiGetJson: vi.fn(async () => ({ success: true })),
}));

vi.mock("@/api/cronTaskClient", () => ({
  getAllCronTasks: vi.fn(async () => []),
  getTabCronTask: vi.fn(async () => null),
  updateCronTaskTab: vi.fn(async () => undefined),
}));

vi.mock("@/api/sessionClient", () => ({
  createSession: mocks.createSession,
  getSessions: mocks.getSessions,
  updateSession: vi.fn(async () => undefined),
}));

vi.mock("@/components/ChatBootOverlay", () => ({
  default: () => <div data-testid="chat-boot-overlay" />,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  default: () => <div data-testid="confirm-dialog" />,
}));

vi.mock("@/components/BugReportOverlay", () => ({
  default: () => <div data-testid="bug-report-overlay" />,
}));

vi.mock("@/components/CustomTitleBar", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="titlebar">{children}</div>
  ),
}));

vi.mock("@/components/LinkContextMenuProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/TabBar", () => ({
  default: ({
    tabs,
    activeTabId,
  }: {
    tabs: Array<{ id: string; title: string }>;
    activeTabId: string | null;
  }) => (
    <div data-testid="tabbar-active">
      {tabs.find((t) => t.id === activeTabId)?.title ?? "missing"}
    </div>
  ),
}));

vi.mock("@/context/TabProvider", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tab-provider">{children}</div>
  ),
}));

vi.mock("@/pages/Chat", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.chatProps.push(props);
    return <div data-testid="chat-page" />;
  },
}));

vi.mock("@/pages/Launcher", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.launcherProps.push(props);
    return <div data-testid="launcher-page" />;
  },
}));

vi.mock("@/pages/Settings", () => ({
  default: () => <div data-testid="settings-page" />,
}));

vi.mock("@/pages/TaskCenter", () => ({
  default: () => <div data-testid="taskcenter-page" />,
}));

vi.mock("@/workbench-sdk/WorkbenchShell", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.workbenchShellProps.push(props);
    return <div data-testid="workbench-shell" />;
  },
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => mocks.toast,
}));

vi.mock("@/hooks/useUpdater", () => ({
  useUpdater: () => ({
    updateReady: false,
    updateVersion: null,
    updateChecking: false,
    updateDownloading: false,
    updateInstalling: false,
    updatePreparing: false,
    pendingUpdateOnStartup: null,
    dismissPendingUpdate: vi.fn(),
    checkForUpdate: vi.fn(async () => "up-to-date"),
    restartAndUpdate: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTrayEvents", () => ({
  useTrayEvents: vi.fn(),
}));

vi.mock("@/hooks/useHelperAgentModelDefaults", () => ({
  useHelperAgentModelDefaults: () => ({
    providerId: mocks.provider.id,
    model: "mimo-v2.5-pro",
    setDefaults: vi.fn(),
  }),
}));

vi.mock("@/hooks/useConfig", () => ({
  useConfig: () => ({
    config: {
      projects: [mocks.project],
      agents: [mocks.agent],
      multiAgentRuntime: mocks.multiAgentRuntime,
      defaultPermissionMode: "auto",
    },
    isLoading: false,
    error: null,
    projects: [mocks.project],
    providers: [mocks.provider],
    apiKeys: { [mocks.provider.id]: "key" },
    providerVerifyStatus: { [mocks.provider.id]: { status: "valid" } },
    addProject: vi.fn(async () => mocks.project),
    updateProject: vi.fn(async () => undefined),
    patchProject: vi.fn(async () => undefined),
    removeProject: vi.fn(async () => undefined),
    touchProject: vi.fn(async () => undefined),
    addCustomProvider: vi.fn(async () => undefined),
    updateCustomProvider: vi.fn(async () => undefined),
    deleteCustomProvider: vi.fn(async () => undefined),
    refreshProviders: vi.fn(async () => undefined),
    savePresetCustomModels: vi.fn(async () => undefined),
    removePresetCustomModel: vi.fn(async () => undefined),
    savePrimaryModel: vi.fn(async () => undefined),
    saveProviderModelAliases: vi.fn(async () => undefined),
    saveApiKey: vi.fn(async () => undefined),
    deleteApiKey: vi.fn(async () => undefined),
    saveProviderVerifyStatus: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    patchProxySettings: vi.fn(async () => undefined),
    refreshConfig: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    refreshProviderData: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/hooks/useTheme", () => ({
  useThemeEffect: vi.fn(),
}));

vi.mock("@/hooks/useTabSwipeGesture", () => ({
  useTabSwipeGesture: vi.fn(),
}));

vi.mock("@/utils/browserMock", () => ({
  isBrowserDevMode: () => false,
  isTauriEnvironment: () => false,
}));

vi.mock("@/utils/frontendLogger", () => ({
  forceFlushLogs: vi.fn(async () => undefined),
  setLogServerUrl: vi.fn(),
  clearLogServerUrl: vi.fn(),
  setAppActiveTabId: mocks.setAppActiveTabId,
}));

vi.mock("@/utils/lastExitMarker", () => ({
  consumeCleanExitMarker: vi.fn(async () => true),
}));

vi.mock("@/utils/tabPersistenceDurable", () => ({
  persistOpenTabsDurable: vi.fn(async () => undefined),
  loadAndClearOpenTabsDurable: vi.fn(async () => null),
  clearOpenTabsDurable: vi.fn(async () => undefined),
}));

vi.mock("@/utils/tauriListen", () => ({
  listenWithCleanup: vi.fn(async () => undefined),
}));

vi.mock("@/config/configService", () => ({
  ensureSelfAwarenessWorkspace: vi.fn(async () => mocks.project),
  resolveBuiltinSelection: mocks.resolveBuiltinSelection,
  pairBuiltinSelection: vi.fn((_provider, model) => ({
    providerId: mocks.provider.id,
    model,
  })),
  isProviderAvailable: vi.fn(() => true),
}));

vi.mock("@/config/services/agentConfigService", () => ({
  getAgentByWorkspacePath: vi.fn(() => mocks.agent),
  getAgentById: vi.fn(() => mocks.agent),
}));

import App from "./App";

describe("App helper launch", () => {
  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.chatProps.length = 0;
    mocks.launcherProps.length = 0;
    mocks.workbenchShellProps.length = 0;
    mocks.agent.runtime = "builtin";
    mocks.agent.permissionMode = "auto";
    mocks.agent.reasoningEffort = undefined;
    mocks.agent.runtimeConfig = undefined;
    mocks.multiAgentRuntime = false;
    mocks.getSessions.mockResolvedValue([]);
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: mocks.provider,
      model: "mimo-v2.5-pro",
    });
  });

  function managedCodexProvider() {
    return {
      ...mocks.provider,
      id: CODEX_SUBSCRIPTION_PROVIDER_ID,
      name: "Codex Subscription",
      type: "subscription",
      baseUrl: "",
      execution: {
        kind: "runtime-backed" as const,
        runtime: "codex" as const,
        source: "managed-provider" as const,
      },
      primaryModel: "gpt-5.5",
      models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
    };
  }

  function latestLauncherProps() {
    const props = mocks.launcherProps.at(-1);
    if (!props) throw new Error("Launcher props were not captured");
    return props as {
      onLaunchProject: (
        project: typeof mocks.project,
        sessionId?: string,
        initialMessage?: unknown,
        analyticsContext?: unknown,
        sessionBirthHint?: unknown,
      ) => void;
    };
  }

  function latestWorkbenchShellProps() {
    const props = mocks.workbenchShellProps.at(-1);
    if (!props) throw new Error("WorkbenchShell props were not captured");
    return props as {
      onOpenAgentSession: (
        workspacePath: string,
        request: {
          version: 1;
          title: string;
          initialMessage: string;
          promptId?: string;
          presentation?: "tab" | "dialog";
          conversationKey?: string;
          forceNew?: boolean;
          toolset?: { id: string; context?: Record<string, string> };
        },
      ) => Promise<void>;
    };
  }

  async function openNovelWorkbench() {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_WORKBENCH, {
          detail: {
            workbenchId: "io.myagents.novel",
            workspacePath: mocks.project.path,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(mocks.workbenchShellProps.length).toBeGreaterThan(0),
    );
  }

  it("prepares a managed Codex provider session when opening an empty Launcher workspace", async () => {
    mocks.agent.runtimeConfig = {
      permissionMode: "suggest",
      reasoningEffort: "xhigh",
    };
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: managedCodexProvider(),
      model: "gpt-5.5",
    });

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        "codex",
        expect.objectContaining({
          runtimeSource: "managed-provider",
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model: "gpt-5.5",
          permissionMode: "suggest",
          reasoningEffort: "xhigh",
          providerExecutionIdentity: expect.objectContaining({
            kind: "runtime-backed-provider",
            providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
            runtime: "codex",
            runtimeSource: "managed-provider",
            model: "gpt-5.5",
          }),
          prepareForFirstUserMessage: true,
          materializationSourceSessionId: expect.stringMatching(/^pending-/),
        }),
      );
    });
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      "prepared-managed-session",
      mocks.project.path,
      "tab",
      expect.stringMatching(/^tab-/),
    );
  });

  it("uses a Launcher birth hint before stale config when opening an empty workspace", async () => {
    const providerExecutionIdentity = {
      kind: "runtime-backed-provider" as const,
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      runtime: "codex" as const,
      runtimeSource: "managed-provider" as const,
      model: "gpt-5.5",
    };

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(
        mocks.project,
        undefined,
        undefined,
        { surface: "agent_card", entryIntent: "open_workspace" },
        {
          providerExecutionIdentity,
          permissionMode: "fullAgency",
          reasoningEffort: "xhigh",
          mcpEnabledServers: ["filesystem"],
          enabledPluginIds: ["plugin-a"],
        },
      );
    });

    await waitFor(() => {
      expect(mocks.createSession).toHaveBeenCalledWith(
        mocks.project.path,
        "codex",
        expect.objectContaining({
          runtimeSource: "managed-provider",
          providerExecutionIdentity,
          providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
          model: "gpt-5.5",
          permissionMode: "no-restrictions",
          reasoningEffort: "xhigh",
          mcpEnabledServers: ["filesystem"],
          enabledPluginIds: ["plugin-a"],
          prepareForFirstUserMessage: true,
          materializationSourceSessionId: expect.stringMatching(/^pending-/),
        }),
      );
    });
  });

  it("keeps external-runtime empty launches on the pending-session path", async () => {
    mocks.multiAgentRuntime = true;
    mocks.agent.runtime = "codex";
    mocks.resolveBuiltinSelection.mockReturnValue({
      provider: managedCodexProvider(),
      model: "gpt-5.5",
    });

    render(<App />);

    await act(async () => {
      latestLauncherProps().onLaunchProject(mocks.project);
    });

    await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
      expect.stringMatching(/^pending-tab-/),
      mocks.project.path,
      "tab",
      expect.stringMatching(/^tab-/),
    );
  });

  it("freezes an available provider selection for workbench Agent auto-send", async () => {
    render(<App />);
    await openNovelWorkbench();

    await act(async () => {
      await latestWorkbenchShellProps().onOpenAgentSession(mocks.project.path, {
        version: 1,
        title: "世界架构向导",
        initialMessage: "创建小说世界",
        promptId: "novel.world.guide",
      });
    });

    await waitFor(() => {
      expect(
        mocks.chatProps.some((props) => {
          const initialMessage = props.initialMessage as
            | { builtinSelection?: { providerId: string; model: string } }
            | undefined;
          return (
            initialMessage?.builtinSelection?.providerId ===
              mocks.provider.id &&
            initialMessage.builtinSelection.model === "mimo-v2.5-pro"
          );
        }),
      ).toBe(true);
    });
    expect(mocks.resolveBuiltinSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: mocks.agent,
        workspace: mocks.project,
      }),
      expect.any(Object),
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("does not start a workbench Agent session without an available provider", async () => {
    mocks.resolveBuiltinSelection.mockReturnValue(undefined);
    render(<App />);
    await openNovelWorkbench();

    await expect(
      latestWorkbenchShellProps().onOpenAgentSession(mocks.project.path, {
        version: 1,
        title: "世界架构向导",
        initialMessage: "创建小说世界",
      }),
    ).rejects.toThrow("当前没有可用的模型服务");
    expect(mocks.ensureSessionSidecar).not.toHaveBeenCalled();
  });

  it("reopens an existing dialog surface without launching a second session", async () => {
    render(<App />);
    await openNovelWorkbench();

    await act(async () => {
      await latestWorkbenchShellProps().onOpenAgentSession(mocks.project.path, {
        version: 1,
        title: "世界架构向导",
        initialMessage: "创建小说世界",
        promptId: "novel.world.guide",
        presentation: "dialog",
        conversationKey: "novel.world.architecture",
      });
    });

    await waitFor(() =>
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      await latestWorkbenchShellProps().onOpenAgentSession(mocks.project.path, {
        version: 1,
        title: "世界架构向导",
        initialMessage: "第二次不应该再发",
        promptId: "novel.world.guide",
        presentation: "dialog",
        conversationKey: "novel.world.architecture",
      });
    });

    // Focus path must not start another sidecar or re-bootstrap a new message.
    expect(mocks.ensureSessionSidecar).toHaveBeenCalledTimes(1);
    expect(
      mocks.chatProps.some((props) => {
        const initialMessage = props.initialMessage as
          | { text?: string }
          | undefined;
        return initialMessage?.text === "第二次不应该再发";
      }),
    ).toBe(false);
    expect(mocks.toast.info).toHaveBeenCalledWith("已回到上次对话");
  });

  it("recreates an empty bound dialog session and re-sends initialMessage", async () => {
    window.localStorage.clear();
    mocks.getSessions.mockResolvedValue([
      {
        id: "empty-bound-session",
        agentDir: mocks.project.path,
        title: "空会话",
        createdAt: "2026-06-27T00:00:00.000Z",
        lastActiveAt: "2026-06-27T00:00:00.000Z",
        stats: { turnCount: 0, totalInputTokens: 0, totalOutputTokens: 0 },
      },
    ]);
    window.localStorage.setItem(
      [
        "myagents.workbench.agent-conversation.v1",
        encodeURIComponent("io.myagents.novel"),
        encodeURIComponent(mocks.project.path),
        encodeURIComponent("novel.world.architecture"),
      ].join(":"),
      "empty-bound-session",
    );

    render(<App />);
    await openNovelWorkbench();

    await act(async () => {
      await latestWorkbenchShellProps().onOpenAgentSession(mocks.project.path, {
        version: 1,
        title: "世界架构向导",
        initialMessage: "重建后的开场",
        promptId: "novel.world.guide",
        presentation: "dialog",
        conversationKey: "novel.world.architecture",
      });
    });

    await waitFor(() => {
      expect(
        mocks.chatProps.some((props) => {
          const initialMessage = props.initialMessage as
            | { text?: string }
            | undefined;
          return initialMessage?.text === "重建后的开场";
        }),
      ).toBe(true);
    });
    expect(mocks.ensureSessionSidecar).toHaveBeenCalled();
  });

  it("forceNew ignores an existing dialog surface and starts a fresh session", async () => {
    render(<App />);
    await openNovelWorkbench();

    await act(async () => {
      await latestWorkbenchShellProps().onOpenAgentSession(mocks.project.path, {
        version: 1,
        title: "世界架构向导",
        initialMessage: "第一次开场",
        promptId: "novel.world.guide",
        presentation: "dialog",
        conversationKey: "novel.world.architecture",
      });
    });
    await waitFor(() =>
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      await latestWorkbenchShellProps().onOpenAgentSession(mocks.project.path, {
        version: 1,
        title: "世界架构向导",
        initialMessage: "强制新开场",
        promptId: "novel.world.guide",
        presentation: "dialog",
        conversationKey: "novel.world.architecture",
        forceNew: true,
      });
    });

    await waitFor(() =>
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledTimes(2),
    );
    expect(
      mocks.chatProps.some((props) => {
        const initialMessage = props.initialMessage as
          | { text?: string }
          | undefined;
        return initialMessage?.text === "强制新开场";
      }),
    ).toBe(true);
  });

  it("commits the helper tab before launching so the active tab is renderable", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
            detail: {
              description: "help",
              providerId: mocks.provider.id,
              model: "mimo-v2.5-pro",
              appVersion: "test",
              images: [],
            },
          }),
        );
      });

      await waitFor(() =>
        expect(mocks.ensureSessionSidecar).toHaveBeenCalled(),
      );

      const launchStart = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((message) => message.includes("[App][launch] START"));

      expect(launchStart).toContain("view=launcher");
      expect(launchStart).not.toContain("view=undefined");
      expect(mocks.setAppActiveTabId).toHaveBeenCalledWith(
        expect.stringMatching(/^tab-/),
        expect.arrayContaining([expect.stringMatching(/^tab-/)]),
      );
      expect(mocks.setAppActiveCorrelation).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: expect.stringMatching(/^tab-/),
        }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("releases the fork tab owner when fork tab activation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
            detail: {
              description: "help",
              providerId: mocks.provider.id,
              model: "mimo-v2.5-pro",
              appVersion: "test",
              images: [],
            },
          }),
        );
      });

      await waitFor(() => {
        expect(
          mocks.chatProps.some(
            (props) => typeof props.onForkSession === "function",
          ),
        ).toBe(true);
      });

      mocks.activateSession.mockRejectedValueOnce(new Error("activate failed"));
      const chatProps = [...mocks.chatProps]
        .reverse()
        .find((props) => typeof props.onForkSession === "function") as {
        onForkSession: (
          sessionId: string,
          agentDir: string,
          title: string,
        ) => Promise<boolean>;
      };

      let opened = true;
      await act(async () => {
        opened = await chatProps.onForkSession(
          "fork-session",
          mocks.project.path,
          "Fork",
        );
      });

      expect(opened).toBe(false);
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        "fork-session",
        mocks.project.path,
        "tab",
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.releaseTabSession).toHaveBeenCalledWith(
        "fork-session",
        expect.stringMatching(/^tab-/),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
