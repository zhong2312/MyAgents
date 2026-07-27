import { describe, expect, it } from "vitest";

import type {
  LocalRegisteredAgent,
  SpaceIssue,
  SpaceSession,
} from "@/api/spaceCloud";
import type { Project } from "@/config/types";
import {
  ALL_ISSUE_STATE_FILTER,
  ACTIVE_ISSUE_STATE_FILTER,
  buildIssueCommandPrompt,
  buildIssueQueryKey,
  compareRegisteredAgentAvailability,
  findJoinedSpaceBySlug,
  formatAgentSecondaryLabel,
  getIssueStatusOptions,
  issueDisplayNumber,
  issueDisplayTitle,
  issueStatusLabel,
  isClosedIssue,
  isRegisteredAgentVisibleInList,
  localAgentMatchesCurrentSpaceIdentity,
  registeredAgentAvailability,
  spaceEventsRequireIssueListRefresh,
  spaceEventsRequireSessionRefresh,
} from "./spaceHelpers";

const session = (
  role: SpaceSession["membership"]["role"],
  userId = "user-1",
): SpaceSession => ({
  baseUrl: "https://space.myagents.test",
  user: { id: userId, email: "user@example.com" },
  space: {
    id: "space-1",
    slug: "official",
    name: "MyAgents社区",
    joinPolicy: "open",
  },
  membership: { id: "membership-1", role },
  updatedAt: "2026-06-24T00:00:00.000Z",
});

const issue = (overrides: Partial<SpaceIssue> = {}): SpaceIssue => ({
  id: "iss_123",
  spaceId: "space-1",
  title: "Test",
  body: "Body",
  state: "todo",
  status: "open",
  author: { id: "user-1", name: "Ethan" },
  commentCount: 0,
  attachmentCount: 0,
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
  ...overrides,
});

describe("space issue helpers", () => {
  it("finds an already joined Space by normalized slug", () => {
    const currentSession = session("member");
    currentSession.spaces = [
      {
        id: "space-2",
        slug: "design-team",
        name: "Design Team",
        joinPolicy: "open",
        membership: { id: "membership-2", role: "member" },
      },
    ];

    expect(findJoinedSpaceBySlug(currentSession, "  DESIGN-TEAM ")?.id).toBe(
      "space-2",
    );
    expect(findJoinedSpaceBySlug(currentSession, "OFFICIAL")?.id).toBe(
      "space-1",
    );
    expect(findJoinedSpaceBySlug(currentSession, "unknown")).toBeNull();
  });

  it("builds a stable issue query key from normalized filters", () => {
    expect(
      buildIssueQueryKey({
        q: "  crash ",
        goalId: " goal_runtime ",
        state: " todo ",
        includeSubtree: true,
        limit: 50,
      }),
    ).toBe(
      "q=crash&state=todo&goalId=goal_runtime&includeSubtree=true&humanOnly=&related=&cursor=&limit=50",
    );
    expect(buildIssueQueryKey({ related: "me" })).toContain("related=me");
  });

  it("keeps the active issue filter aligned with non-terminal states", () => {
    expect(ALL_ISSUE_STATE_FILTER).toBe("all");
    expect(ACTIVE_ISSUE_STATE_FILTER.split(",")).toEqual([
      "open",
      "todo",
      "doing",
    ]);
    expect(ACTIVE_ISSUE_STATE_FILTER.split(",")).not.toContain("done");
    expect(ACTIVE_ISSUE_STATE_FILTER.split(",")).not.toContain("closed");
  });

  it("builds a concise read-first Issue handoff prompt", () => {
    const prompt = buildIssueCommandPrompt({
      spaceName: "MyAgents社区",
      spaceSlug: "official",
      issueId: "iss_123",
    });

    expect(prompt).toBe([
      "Instruction: 这是一个来自 MyAgents Space「MyAgents社区」的 Issue。请先通过下方只读命令获取当前上下文（标题、正文、附件元数据和最新评论）；如附件与判断有关，按需下载并读取。读取后，先向用户概括你的理解并提出下一步建议，等待用户确认后再修改代码、执行处理动作或变更 Issue 状态。",
      "",
      "- Issue ID: iss_123",
      "- Space slug: official",
      "",
      "阅读 Issue：",
      "`myagents space issue view iss_123 --space official --comments --json`",
      "",
      "查看其他可用操作：",
      "`myagents space issue --help`",
    ].join("\n"));
    expect(prompt).not.toContain("myagents space issue claim");
    expect(prompt).not.toContain("myagents space issue complete");
    expect(prompt).not.toContain("myagents issue iss_123");
  });

  it("exposes status options by permission", () => {
    const ownerOptions = getIssueStatusOptions({
      session: session("owner"),
      issue: issue(),
    });
    expect(ownerOptions.map((option) => option.value)).toEqual([
      "open",
      "todo",
      "doing",
      "done",
      "closed",
    ]);

    expect(
      getIssueStatusOptions({ session: session("member"), issue: issue() }),
    ).toEqual([{ value: "closed", label: "Close issue", kind: "close-own" }]);
    expect(
      getIssueStatusOptions({
        session: session("member", "other-user"),
        issue: issue(),
      }),
    ).toEqual([]);
    expect(
      getIssueStatusOptions({
        session: session("member"),
        issue: issue({ state: "closed" }),
      }),
    ).toEqual([]);
  });

  it("strips duplicated status prefixes from issue display titles", () => {
    expect(issueDisplayTitle(issue({ title: "[todo] Seed issue 1" }))).toBe(
      "Seed issue 1",
    );
    expect(issueDisplayTitle(issue({ title: "[triaged] Seed issue 2" }))).toBe(
      "[triaged] Seed issue 2",
    );
    expect(
      issueDisplayTitle(
        issue({ state: "doing", title: "[doing] Seed issue 3" }),
      ),
    ).toBe("Seed issue 3");
  });

  it("formats issue numbers from explicit API fields only", () => {
    expect(issueDisplayNumber(issue({ number: 42 }))).toBe("#42");
    expect(issueDisplayNumber(issue({ issueNumber: 7 }))).toBe("#7");
    expect(issueDisplayNumber(issue({ id: "issue_113" }))).toBeNull();
    expect(issueDisplayNumber(issue({ id: "iss-mock-114" }))).toBeNull();
    expect(
      issueDisplayNumber(issue({ id: "uuid-like-id", title: "Seed issue 99" })),
    ).toBeNull();
    expect(
      issueDisplayNumber(issue({ id: "uuid-like-id", number: 0 })),
    ).toBeNull();
  });

  it("uses translated status labels with raw-token fallback", () => {
    const t = (key: string, options?: { defaultValue?: string }) =>
      key === "space.issueStatuses.todo"
        ? "待办"
        : (options?.defaultValue ?? key);

    expect(issueStatusLabel("todo", t)).toBe("待办");
    expect(issueStatusLabel("custom_state", t)).toBe("custom state");
  });

  it("formats agent workspace labels through project identity first", () => {
    const projects = [
      {
        id: "project-1",
        path: "/workspace/a",
        name: "Repo A",
        displayName: "Workspace A",
      },
    ] as Project[];
    const agent = {
      id: "agent-1",
      baseUrl: "https://space.myagents.test",
      spaceId: "space-1",
      workspaceId: "project-1",
      displayName: "Builder",
      instruction: "Build issues.",
      instructionRevision: 1,
      subscriptions: [],
      workspacePath: "/workspace/a",
      workspaceLabel: "Stored label",
      goalId: "goal_runtime",
      goalPathLabel: "Runtime",
      stateFilter: ["todo"],
      issueSubscriptionRunMode: "single_session",
      status: "active",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    } satisfies LocalRegisteredAgent;

    expect(formatAgentSecondaryLabel(agent, projects)).toBe("Workspace A");
    expect(isClosedIssue("closed")).toBe(true);
  });

  it("hides revoked registered agents from the Agents list", () => {
    expect(isRegisteredAgentVisibleInList({ status: "active" })).toBe(true);
    expect(isRegisteredAgentVisibleInList({ status: "disabled" })).toBe(true);
    expect(isRegisteredAgentVisibleInList({ status: " revoked " })).toBe(false);
    expect(isRegisteredAgentVisibleInList({ status: "REVOKED" })).toBe(false);
  });

  it("keeps Agent management state separate from connector presence", () => {
    expect(
      registeredAgentAvailability({ status: "active", presence: "online" }),
    ).toBe("online");
    expect(
      registeredAgentAvailability({ status: "active", presence: "offline" }),
    ).toBe("offline");
    expect(
      registeredAgentAvailability({
        status: "active",
        presence: "offline",
        connecting: true,
      }),
    ).toBe("connecting");
    expect(
      registeredAgentAvailability({ status: "disabled", presence: "online" }),
    ).toBe("disabled");

    const agents = [
      {
        id: "disabled",
        status: "disabled",
        presence: "online" as const,
        lastOnlineAt: "2026-07-11T12:00:00Z",
      },
      {
        id: "offline-new",
        status: "active",
        presence: "offline" as const,
        lastOnlineAt: "2026-07-11T11:00:00Z",
      },
      {
        id: "online-old",
        status: "active",
        presence: "online" as const,
        lastOnlineAt: "2026-07-11T10:00:00Z",
      },
      {
        id: "online-new",
        status: "active",
        presence: "online" as const,
        lastOnlineAt: "2026-07-11T12:00:00Z",
      },
    ].sort(compareRegisteredAgentAvailability);
    expect(agents.map((agent) => agent.id)).toEqual([
      "online-new",
      "online-old",
      "offline-new",
      "disabled",
    ]);
  });

  it("invalidates the session projection for plan change events", () => {
    expect(
      spaceEventsRequireSessionRefresh([
        { type: "space.plan_changed", resourceType: "space" },
      ]),
    ).toBe(true);
    expect(
      spaceEventsRequireSessionRefresh([
        { type: "issue.updated", resourceType: "issue" },
      ]),
    ).toBe(false);
  });

  it("silently refreshes the issue list for remote issue-affecting events", () => {
    for (const event of [
      { type: "issue.updated", resourceType: "issue" },
      { type: "comment.created", resourceType: "comment" },
      { type: "goal.updated", resourceType: "goal" },
      { type: "delivery.completed", resourceType: "delivery" },
      { type: "comment.created", resourceType: undefined },
    ]) {
      expect(spaceEventsRequireIssueListRefresh([event])).toBe(true);
    }

    expect(
      spaceEventsRequireIssueListRefresh([
        { type: "skill.updated", resourceType: "skill" },
      ]),
    ).toBe(false);
  });

  it("requires local registered agents to match the current space identity", () => {
    const agent = {
      id: "agent-1",
      baseUrl: "https://space.myagents.test",
      spaceId: "space-1",
      ownerUserId: "user-1",
      deviceId: "device-1",
      workspaceId: "project-1",
      displayName: "Builder",
      instruction: "Build issues.",
      instructionRevision: 1,
      subscriptions: [],
      workspacePath: "/workspace/a",
      goalId: "goal_runtime",
      goalPathLabel: "Runtime",
      stateFilter: ["todo"],
      issueSubscriptionRunMode: "single_session",
      status: "active",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    } satisfies LocalRegisteredAgent;

    expect(
      localAgentMatchesCurrentSpaceIdentity(
        agent,
        "space-1",
        "user-1",
        "device-1",
      ),
    ).toBe(true);
    expect(
      localAgentMatchesCurrentSpaceIdentity(
        agent,
        "space-2",
        "user-1",
        "device-1",
      ),
    ).toBe(false);
  });
});
