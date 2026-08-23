import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceSession } from "@/api/spaceCloud";
import { i18n } from "@/i18n";
import { SpaceLogin, SpaceSidebar } from "./SpaceChrome";

vi.mock("@/hooks/useCloseLayer", () => ({
  useCloseLayer: vi.fn(),
}));

const session: SpaceSession = {
  user: { id: "u-1", email: "user@example.com", name: "User" },
  space: {
    id: "space-1",
    slug: "official",
    name: "Official Space",
    joinPolicy: "open_join",
  },
  membership: { id: "membership-1", role: "member" },
  baseUrl: "https://space.myagents.test",
  updatedAt: "2026-06-28T00:00:00.000Z",
};

describe("SpaceChrome i18n", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  const sidebarProps = {
    onSpaceTabChange: vi.fn(),
    onSpaceSwitch: vi.fn(),
    onJoinSpace: vi.fn(),
    onCreateSpace: vi.fn(),
    onLogout: vi.fn(),
    onOpenProfileSettings: vi.fn(),
  };

  it("renders login chrome in English", () => {
    render(<SpaceLogin authBusy={false} authFlow={null} onLogin={vi.fn()} />);

    expect(
      screen.getByRole("heading", { name: "MyAgents Community" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("MyAgents 社区")).not.toBeInTheDocument();
    expect(screen.queryByText("继续使用 Google")).not.toBeInTheDocument();
  });

  it("renders reauthentication as an account recovery action", () => {
    const onLogin = vi.fn();
    const onForgetAccount = vi.fn();
    render(
      <SpaceLogin
        authBusy={false}
        authFlow={null}
        onLogin={onLogin}
        reauthRequired
        accountName="User"
        onForgetAccount={onForgetAccount}
      />,
    );

    expect(
      screen.getByText(
        "The sign-in for User is no longer valid. Sign in again to continue.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Sign out and forget this account",
      }),
    );
    expect(onLogin).toHaveBeenCalledOnce();
    expect(onForgetAccount).toHaveBeenCalledOnce();
  });

  it("renders sidebar account menu in English without translating data", () => {
    render(<SpaceSidebar session={session} mode="issues" {...sidebarProps} />);

    expect(screen.getAllByText("Official Space").length).toBeGreaterThan(0);
    expect(screen.getByText("Open to join")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Join Space" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Space" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Agents" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Settings" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /user/i }));
    expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("开放加入")).not.toBeInTheDocument();
    expect(screen.queryByText("退出登录")).not.toBeInTheDocument();
  });

  it("renders the localized Chinese Space navigation labels", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<SpaceSidebar session={session} mode="issues" {...sidebarProps} />);

    expect(
      screen.getByRole("button", { name: "加入空间" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建空间" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "议题 Issue" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "目标 Goals" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "技能 Skills" }),
    ).toBeInTheDocument();
  });

  it("expands Space navigation locally and keeps only one Space expanded", () => {
    const onSpaceSwitch = vi.fn();
    const maSpace = {
      id: "space-2",
      slug: "ma",
      name: "MA",
      joinPolicy: "approval_required",
    };
    const maMembership = {
      id: "membership-2",
      spaceId: "space-2",
      role: "owner" as const,
    };
    render(
      <SpaceSidebar
        session={{
          ...session,
          space: maSpace,
          membership: maMembership,
          spaces: [
            {
              ...session.space,
              membership: session.membership,
            },
            {
              ...maSpace,
              membership: maMembership,
            },
          ],
        }}
        mode="issues"
        {...sidebarProps}
        onSpaceSwitch={onSpaceSwitch}
      />,
    );

    const spaceList = screen.getByRole("list");
    const officialSpaceItem = screen.getByText("Official Space").closest("li");
    const activeSpaceItem = screen.getByText("MA").closest("li");
    expect(officialSpaceItem?.parentElement).toBe(spaceList);
    expect(activeSpaceItem?.parentElement).toBe(spaceList);
    expect(
      within(activeSpaceItem!).getByRole("navigation", {
        name: "MA",
      }),
    ).toBeInTheDocument();
    expect(
      within(officialSpaceItem!).queryByRole("navigation"),
    ).not.toBeInTheDocument();

    const officialSpaceToggle = within(officialSpaceItem!).getByRole("button", {
      name: /Official Space/,
    });
    const activeSpaceToggle = within(activeSpaceItem!).getByRole("button", {
      name: /MA/,
    });
    expect(officialSpaceToggle).toHaveAttribute("aria-expanded", "false");
    expect(activeSpaceToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(officialSpaceToggle);

    expect(onSpaceSwitch).not.toHaveBeenCalled();
    expect(officialSpaceToggle).toHaveAttribute("aria-expanded", "true");
    expect(activeSpaceToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(officialSpaceItem!).getByRole("navigation", {
        name: "Official Space",
      }),
    ).toBeInTheDocument();
    expect(
      within(activeSpaceItem!).queryByRole("navigation"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(officialSpaceItem!).getByRole("button", { name: "Issues" }),
    );
    expect(onSpaceSwitch).toHaveBeenCalledWith("space-1", "issues");
  });

  it("localizes approval-required and unknown join policies without exposing tokens", async () => {
    await i18n.changeLanguage("zh-CN");
    const { rerender } = render(
      <SpaceSidebar
        session={{
          ...session,
          space: { ...session.space, joinPolicy: "approval_required" },
        }}
        mode="issues"
        {...sidebarProps}
      />,
    );

    expect(screen.getByText("需审核加入")).toBeInTheDocument();
    expect(screen.queryByText("approval required")).not.toBeInTheDocument();

    rerender(
      <SpaceSidebar
        session={{
          ...session,
          space: { ...session.space, joinPolicy: "future_policy" },
        }}
        mode="issues"
        {...sidebarProps}
      />,
    );

    expect(screen.getByText("未知加入方式")).toBeInTheDocument();
    expect(screen.queryByText("future policy")).not.toBeInTheDocument();
  });

  it("shows Space Settings only for admins and surfaces pending join requests", () => {
    const adminSession: SpaceSession = {
      ...session,
      membership: { ...session.membership, role: "admin" },
      spaces: [
        {
          ...session.space,
          membership: { ...session.membership, role: "admin" },
          canManage: true,
          pendingJoinRequestCount: 2,
        },
      ],
    };
    render(
      <SpaceSidebar session={adminSession} mode="settings" {...sidebarProps} />,
    );

    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Agents" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("closes the sidebar account menu when clicking outside", async () => {
    render(<SpaceSidebar session={session} mode="issues" {...sidebarProps} />);

    fireEvent.click(screen.getByRole("button", { name: /user/i }));
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Sign out" }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows account-level Pro identity and refreshes a stale projection on open", async () => {
    const refreshAccountPlan = vi.fn().mockResolvedValue(undefined);
    const proSession: SpaceSession = {
      ...session,
      updatedAt: new Date().toISOString(),
      accountPlan: {
        effectiveTier: "pro",
        evaluatedAt: "2026-07-11T00:00:00.000Z",
        membership: {
          planTier: "pro",
          status: "active",
          startsAt: "2026-07-01T00:00:00.000Z",
          expiresAt: "2099-10-11T00:00:00.000Z",
          revokedAt: null,
          source: "operations",
          version: 1,
        },
      },
    };
    render(
      <SpaceSidebar
        session={proSession}
        mode="issues"
        {...sidebarProps}
        onRefreshAccountPlan={refreshAccountPlan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /user/i }));

    expect(screen.getByText("PRO")).toBeInTheDocument();
    expect(screen.getByText(/Pro account · valid until/)).toBeInTheDocument();
    await waitFor(() => expect(refreshAccountPlan).toHaveBeenCalledTimes(1));
  });

  it("fails closed to Free when a cached active membership is already expired", async () => {
    const refreshAccountPlan = vi.fn().mockResolvedValue(undefined);
    const expiredSession: SpaceSession = {
      ...session,
      accountPlan: {
        effectiveTier: "pro",
        evaluatedAt: "2026-07-01T00:00:00.000Z",
        membership: {
          planTier: "pro",
          status: "active",
          startsAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2026-07-01T00:00:00.000Z",
          revokedAt: null,
          source: "operations",
          version: 1,
        },
      },
    };
    render(
      <SpaceSidebar
        session={expiredSession}
        mode="issues"
        {...sidebarProps}
        onRefreshAccountPlan={refreshAccountPlan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /user/i }));

    expect(screen.queryByText("PRO")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Free account · Pro expired on/),
    ).toBeInTheDocument();
    await waitFor(() => expect(refreshAccountPlan).toHaveBeenCalledTimes(1));
  });

  it("shows a revoked membership as Free instead of expired Pro history", () => {
    const revokedSession: SpaceSession = {
      ...session,
      accountPlan: {
        effectiveTier: "free",
        evaluatedAt: "2026-07-11T00:00:00.000Z",
        membership: {
          planTier: "pro",
          status: "revoked",
          startsAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2026-07-01T00:00:00.000Z",
          revokedAt: "2026-06-20T00:00:00.000Z",
          source: "operations",
          version: 2,
        },
      },
    };
    render(
      <SpaceSidebar session={revokedSession} mode="issues" {...sidebarProps} />,
    );

    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /user/i }));

    expect(screen.getByText("FREE")).toBeInTheDocument();
    expect(screen.getByText("Free account")).toBeInTheDocument();
    expect(screen.queryByText(/Pro expired on/)).not.toBeInTheDocument();
  });
});
