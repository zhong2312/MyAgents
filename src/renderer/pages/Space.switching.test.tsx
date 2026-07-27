import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceSession } from "@/api/spaceCloud";
import Space from "@/pages/Space";

const harness = vi.hoisted(() => ({
  data: null as unknown as Record<string, unknown>,
  actions: {
    switchSpace: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshIssues: vi.fn().mockResolvedValue(undefined),
    refreshGoals: vi.fn().mockResolvedValue(undefined),
    refreshSkills: vi.fn().mockResolvedValue(undefined),
    refreshLocalAgents: vi.fn().mockResolvedValue(undefined),
    refreshRegisteredAgents: vi.fn().mockResolvedValue(undefined),
    syncEvents: vi.fn().mockResolvedValue([]),
  },
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => harness.toast,
}));

vi.mock("@/hooks/useConfig", () => ({
  useConfig: () => ({ projects: [] }),
}));

vi.mock("@/hooks/useWorkspaceFileService", () => ({
  useWorkspaceFileService: () => ({ readPathsAsBase64: vi.fn() }),
}));

vi.mock("@/identity/deviceIdentity", () => ({
  getDeviceId: () => "device-test",
  preloadDeviceId: () => Promise.resolve(),
}));

vi.mock("@/pages/space/useSpaceData", () => ({
  useSpaceData: () => harness.data,
}));

vi.mock("@/pages/space/spaceStore", () => ({
  SPACE_VISIBLE_REFRESH_TTL_MS: 30_000,
  getIssueListState: () => ({
    items: [],
    hasMore: false,
    nextCursor: null,
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/pages/space/SpaceChrome", () => ({
  SpaceLogin: () => <div>login</div>,
  SpaceSidebar: ({
    onSpaceTabChange,
    onSpaceSwitch,
    onLogout,
  }: {
    onSpaceTabChange: (mode: string) => void;
    onSpaceSwitch: (spaceId: string, mode: string) => void;
    onLogout: () => void;
  }) => (
    <aside>
      <button type="button" onClick={() => onSpaceTabChange("skills")}>
        show skills
      </button>
      <button type="button" onClick={() => onSpaceTabChange("goals")}>
        show goals
      </button>
      <button type="button" onClick={() => onSpaceTabChange("settings")}>
        show settings
      </button>
      <button type="button" onClick={() => onSpaceTabChange("issues")}>
        show issues
      </button>
      <button type="button" onClick={() => onSpaceSwitch("team", "skills")}>
        show team skills
      </button>
      <button type="button" onClick={() => onSpaceSwitch("team", "issues")}>
        show team issues
      </button>
      <button type="button" onClick={onLogout}>
        logout
      </button>
    </aside>
  ),
}));

vi.mock("@/pages/space/issues/IssuesWorkspace", () => ({
  IssuesWorkspace: ({
    selectedStatus,
    selectedStatusPreset,
    onStatusChange,
    onOpenIssue,
  }: {
    selectedStatus: string;
    selectedStatusPreset: string;
    onStatusChange: (value: string) => void;
    onOpenIssue: (issueId: string) => void;
  }) => (
    <main>
      issues
      <output aria-label="selected issue status">
        {selectedStatus || "empty"}
      </output>
      <output aria-label="remembered issue status">
        {selectedStatusPreset || "empty"}
      </output>
      <button type="button" onClick={() => onStatusChange("open,todo,doing")}>
        set incomplete
      </button>
      <button type="button" onClick={() => onStatusChange("doing")}>
        set doing
      </button>
      <button type="button" onClick={() => onStatusChange("all")}>
        set all
      </button>
      <button
        type="button"
        onClick={() => onStatusChange(selectedStatusPreset)}
      >
        restore remembered status
      </button>
      <button type="button" onClick={() => onOpenIssue("issue-1")}>
        open issue detail
      </button>
    </main>
  ),
}));

vi.mock("@/pages/space/goals/GoalsWorkspace", () => ({
  GoalsWorkspace: ({
    onOpenIssuesForGoal,
  }: {
    onOpenIssuesForGoal: (goalId: string) => void;
  }) => (
    <main>
      goals
      <button type="button" onClick={() => onOpenIssuesForGoal("goal-1")}>
        open issues from goal
      </button>
    </main>
  ),
}));

vi.mock("@/pages/space/issues/CreateIssueDialog", () => ({
  CreateIssueDialog: () => null,
}));

vi.mock("@/pages/space/issues/IssueDetailDrawer", () => ({
  IssueDetailDrawer: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="issue detail">
      <button type="button" onClick={onClose}>
        close issue detail
      </button>
    </div>
  ),
}));

vi.mock("@/pages/space/skills/SkillsWorkspace", () => ({
  SkillsWorkspace: () => <main>skills</main>,
}));

vi.mock("@/pages/space/settings/SpaceSettingsWorkspace", () => ({
  SpaceSettingsWorkspace: ({ onExit }: { onExit: () => void }) => (
    <main>
      settings
      <button type="button" onClick={onExit}>
        exit settings
      </button>
    </main>
  ),
}));

vi.mock("@/api/spaceCloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/spaceCloud")>();
  return {
    ...actual,
    spaceWakeConnector: vi.fn().mockResolvedValue(undefined),
  };
});

function sessionFor(
  id: string,
  slug: string,
  baseUrl = "https://space.myagents.test",
  role: "admin" | "member" = "member",
): SpaceSession {
  return {
    baseUrl,
    user: { id: "user-1", email: "user@example.com", name: "User" },
    space: {
      id,
      slug,
      name: slug,
      joinPolicy: "open_join",
    },
    membership: { id: `membership-${id}`, role },
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function snapshot(
  spaceId: string,
  baseUrl = "https://space.myagents.test",
  role: "admin" | "member" = "member",
) {
  const session = sessionFor(`id-${spaceId}`, spaceId, baseUrl, role);
  return {
    boot: "ready",
    bootError: null,
    serviceBaseUrl: session.baseUrl,
    session,
    spaceId,
    goals: [],
    skills: { items: [], lastFetchedAt: 0, isLoading: false, error: null },
    issueDetails: {},
    localAgents: { items: [], lastFetchedAt: 0, isLoading: false, error: null },
    registeredAgents: {
      items: [],
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    },
    actions: harness.actions,
  };
}

describe("Space switching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.actions.switchSpace.mockReset().mockResolvedValue(undefined);
    harness.actions.logout.mockReset().mockResolvedValue(undefined);
    harness.actions.refreshIssues.mockClear();
    harness.actions.refreshGoals.mockClear();
    harness.actions.refreshSkills.mockClear();
    harness.actions.refreshLocalAgents.mockClear();
    harness.actions.refreshRegisteredAgents.mockClear();
    harness.actions.syncEvents.mockClear();
    harness.data = snapshot("ma");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads Issues and resets the status when the active data scope changes", async () => {
    const view = render(<Space isActive />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(1);
    expect(harness.actions.refreshGoals).toHaveBeenCalledTimes(1);
    expect(harness.actions.refreshIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "open,todo,doing" }),
      expect.any(Object),
    );
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");

    harness.data = snapshot("myagents");
    view.rerender(<Space isActive />);

    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
    expect(
      screen.getByRole("status", { name: "remembered issue status" }),
    ).toHaveTextContent("open,todo,doing");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(2);
    expect(harness.actions.refreshGoals).toHaveBeenCalledTimes(2);
  });

  it("commits the target tab before Space persistence finishes", async () => {
    const switching = deferred<void>();
    harness.actions.switchSpace.mockReturnValueOnce(switching.promise);
    render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "show team skills" }));

    expect(harness.actions.switchSpace).toHaveBeenCalledWith("team", undefined);
    expect(screen.getByRole("main")).toHaveTextContent("skills");

    await act(async () => {
      switching.resolve();
      await switching.promise;
    });
  });

  it("resets the Issue status to incomplete when entering another Space", () => {
    const view = render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");

    fireEvent.click(screen.getByRole("button", { name: "show team issues" }));

    expect(harness.actions.switchSpace).toHaveBeenCalledWith("team", undefined);
    harness.data = snapshot("team");
    view.rerender(<Space isActive />);
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
  });

  it("remembers the right-hand status behind All but resets after leaving Issues", () => {
    harness.data = snapshot("ma", undefined, "admin");
    render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "open issue detail" }));
    fireEvent.click(screen.getByRole("button", { name: "close issue detail" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");
    fireEvent.click(screen.getByRole("button", { name: "set all" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("all");
    expect(
      screen.getByRole("status", { name: "remembered issue status" }),
    ).toHaveTextContent("doing");

    fireEvent.click(
      screen.getByRole("button", { name: "restore remembered status" }),
    );
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("doing");

    fireEvent.click(screen.getByRole("button", { name: "show skills" }));
    fireEvent.click(screen.getByRole("button", { name: "show issues" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
    expect(
      screen.getByRole("status", { name: "remembered issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "show goals" }));
    fireEvent.click(
      screen.getByRole("button", { name: "open issues from goal" }),
    );
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "show settings" }));
    fireEvent.click(screen.getByRole("button", { name: "exit settings" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
  });

  it("resets when the Space page deactivates or Settings becomes inaccessible", () => {
    harness.data = snapshot("ma", undefined, "admin");
    const view = render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    view.rerender(<Space isActive={false} />);
    view.rerender(<Space isActive />);
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));
    fireEvent.click(screen.getByRole("button", { name: "show settings" }));
    harness.data = snapshot("ma", undefined, "member");
    view.rerender(<Space isActive />);
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
  });

  it("resets the Issue status at the local logout boundary", async () => {
    const remoteLogout = deferred<void>();
    harness.actions.logout.mockReturnValueOnce(remoteLogout.promise);
    render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set all" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("all");

    fireEvent.click(screen.getByRole("button", { name: "logout" }));

    expect(harness.actions.logout).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    fireEvent.click(screen.getByRole("button", { name: "set all" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("all");

    await act(async () => {
      remoteLogout.resolve();
      await remoteLogout.promise;
    });
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("all");
    expect(harness.toast.success).toHaveBeenCalledTimes(1);
  });

  it("keeps the incomplete default when remote logout fails after local sign-out", async () => {
    harness.actions.logout.mockRejectedValueOnce(
      new Error("remote unavailable"),
    );
    render(<Space isActive />);

    fireEvent.click(screen.getByRole("button", { name: "set all" }));
    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("all");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "logout" }));
    });

    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");
    expect(harness.toast.error).toHaveBeenCalledTimes(1);
  });

  it("reloads the selected non-Issue workspace for the new Space", async () => {
    const view = render(<Space isActive />);
    fireEvent.click(screen.getByRole("button", { name: "show skills" }));

    expect(harness.actions.refreshSkills).toHaveBeenCalledTimes(1);

    harness.data = snapshot("myagents");
    view.rerender(<Space isActive />);

    expect(harness.actions.refreshSkills).toHaveBeenCalledTimes(2);
  });

  it("reloads the same Space slug when the service origin changes", async () => {
    harness.data = snapshot("official", "https://space.myagents.test");
    const view = render(<Space isActive />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "set doing" }));

    harness.data = snapshot("official", "https://space-dev.myagents.test");
    view.rerender(<Space isActive />);

    expect(
      screen.getByRole("status", { name: "selected issue status" }),
    ).toHaveTextContent("open,todo,doing");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(harness.actions.refreshIssues).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
