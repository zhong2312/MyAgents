import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  findProjectForAgent: vi.fn(),
  spaceArchiveGoal: vi.fn(),
  spaceCancelIssueClaim: vi.fn(),
  spaceCancelIssueAssignee: vi.fn(),
  spaceCloseIssue: vi.fn(),
  spaceCloseOwnIssue: vi.fn(),
  spaceCommentIssue: vi.fn(),
  spaceCreateGoal: vi.fn(),
  spaceCompleteIssue: vi.fn(),
  spaceCreateIssue: vi.fn(),
  spaceDeleteSkill: vi.fn(),
  spaceDownloadIssueAttachment: vi.fn(),
  spaceGetIssue: vi.fn(),
  spaceGetOfficial: vi.fn(),
  spaceGetCapability: vi.fn(),
  spaceGetSession: vi.fn(),
  spaceGetSkill: vi.fn(),
  spaceGetSkillFile: vi.fn(),
  spaceInstallSkill: vi.fn(),
  spaceListSkillRevisions: vi.fn(),
  spaceListGoals: vi.fn(),
  spaceListEvents: vi.fn(),
  spaceListIssues: vi.fn(),
  spaceListIssueComments: vi.fn(),
  spaceListLocalAgents: vi.fn(),
  spaceListRegisteredAgents: vi.fn(),
  spaceListSkills: vi.fn(),
  spaceLogout: vi.fn(),
  spaceRegisterAgent: vi.fn(),
  spaceRevokeRegisteredAgent: vi.fn(),
  spaceRollbackSkill: vi.fn(),
  spaceSetActiveSpace: vi.fn(),
  spaceSetIssueState: vi.fn(),
  spaceSetIssueAssignee: vi.fn(),
  spaceUpdateGoal: vi.fn(),
  spaceUpdateIssue: vi.fn(),
  spaceUpdateProfile: vi.fn(),
  spaceUpdateRegisteredAgent: vi.fn(),
  spaceUploadIssueAttachments: vi.fn(),
  spaceUploadSkillZip: vi.fn(),
}));

vi.mock("@/api/spaceCloud", () => ({
  DEFAULT_SPACE_ID: "official",
  findProjectForAgent: apiMocks.findProjectForAgent,
  spaceArchiveGoal: apiMocks.spaceArchiveGoal,
  spaceCancelIssueClaim: apiMocks.spaceCancelIssueClaim,
  spaceCancelIssueAssignee: apiMocks.spaceCancelIssueAssignee,
  spaceCloseIssue: apiMocks.spaceCloseIssue,
  spaceCloseOwnIssue: apiMocks.spaceCloseOwnIssue,
  spaceCommentIssue: apiMocks.spaceCommentIssue,
  spaceCreateGoal: apiMocks.spaceCreateGoal,
  spaceCompleteIssue: apiMocks.spaceCompleteIssue,
  spaceCreateIssue: apiMocks.spaceCreateIssue,
  spaceDeleteSkill: apiMocks.spaceDeleteSkill,
  spaceDownloadIssueAttachment: apiMocks.spaceDownloadIssueAttachment,
  spaceGetIssue: apiMocks.spaceGetIssue,
  spaceGetOfficial: apiMocks.spaceGetOfficial,
  spaceGetCapability: apiMocks.spaceGetCapability,
  spaceGetSession: apiMocks.spaceGetSession,
  spaceGetSkill: apiMocks.spaceGetSkill,
  spaceGetSkillFile: apiMocks.spaceGetSkillFile,
  spaceInstallSkill: apiMocks.spaceInstallSkill,
  spaceListSkillRevisions: apiMocks.spaceListSkillRevisions,
  spaceListGoals: apiMocks.spaceListGoals,
  spaceListEvents: apiMocks.spaceListEvents,
  spaceListIssues: apiMocks.spaceListIssues,
  spaceListIssueComments: apiMocks.spaceListIssueComments,
  spaceListLocalAgents: apiMocks.spaceListLocalAgents,
  spaceListRegisteredAgents: apiMocks.spaceListRegisteredAgents,
  spaceListSkills: apiMocks.spaceListSkills,
  spaceLogout: apiMocks.spaceLogout,
  spaceRegisterAgent: apiMocks.spaceRegisterAgent,
  spaceRevokeRegisteredAgent: apiMocks.spaceRevokeRegisteredAgent,
  spaceRollbackSkill: apiMocks.spaceRollbackSkill,
  spaceSetActiveSpace: apiMocks.spaceSetActiveSpace,
  spaceSetIssueState: apiMocks.spaceSetIssueState,
  spaceSetIssueAssignee: apiMocks.spaceSetIssueAssignee,
  spaceUpdateGoal: apiMocks.spaceUpdateGoal,
  spaceUpdateIssue: apiMocks.spaceUpdateIssue,
  spaceUpdateProfile: apiMocks.spaceUpdateProfile,
  spaceUpdateRegisteredAgent: apiMocks.spaceUpdateRegisteredAgent,
  spaceUploadIssueAttachments: apiMocks.spaceUploadIssueAttachments,
  spaceUploadSkillZip: apiMocks.spaceUploadSkillZip,
}));

const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock("@/analytics", () => ({
  track: analyticsMocks.track,
}));

import type {
  LocalRegisteredAgent,
  SpaceEvent,
  SpaceGoal,
  SpaceIssue,
  SpaceIssueComment,
  SpaceIssueDetail,
  SpaceSession,
  SpaceSkill,
} from "@/api/spaceCloud";
import {
  SPACE_MAX_ISSUE_DETAIL_CACHES,
  SPACE_MAX_SKILL_FILE_CACHES,
  __resetSpaceStoreForTest,
  __setSpaceStoreStateForTest,
  actions,
  getIssueListState,
  getSkillFileState,
  getSnapshot,
} from "./spaceStore";

const fakeSession: SpaceSession = {
  sessionBindingId: "binding-old",
  baseUrl: "https://space.myagents.test",
  user: { id: "user-1", email: "user@example.com" },
  space: {
    id: "space-1",
    slug: "official",
    name: "MyAgents社区",
    joinPolicy: "open",
  },
  membership: { id: "membership-1", role: "owner" },
  updatedAt: "2026-06-24T00:00:00.000Z",
};

const fakeIssue: SpaceIssue = {
  id: "iss_123",
  spaceId: "space-1",
  title: "Test",
  body: "Body",
  state: "todo",
  goalId: "goal-1",
  goalPathLabel: "Runtime",
  humanOnly: false,
  creator: { id: "user-1", name: "Ethan" },
  status: "open",
  author: { id: "user-1", name: "Ethan" },
  commentCount: 0,
  attachmentCount: 0,
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
};

const fakeGoal: SpaceGoal = {
  id: "goal-1",
  spaceId: "space-1",
  parentGoalId: null,
  path: "/goal-1/",
  depth: 0,
  title: "Runtime",
  context: "Runtime work",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
  goalPathLabel: "Runtime",
};

const fakeChildGoal: SpaceGoal = {
  id: "goal-child",
  spaceId: "space-1",
  parentGoalId: "goal-1",
  path: "/goal-1/goal-child/",
  depth: 1,
  title: "Runtime Child",
  context: "Child runtime work",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
  goalPathLabel: "Runtime / Runtime Child",
};

const fakeDetail: SpaceIssueDetail = {
  issue: fakeIssue,
  comments: {
    items: [],
    hasMore: false,
    nextCursor: null,
    limit: 5,
  },
  attachments: [],
};

const fakeSkill: SpaceSkill = {
  id: "skl_123",
  name: "PRD Writer",
  slug: "prd-writer",
  description: "Write product specs",
  currentRevision: 1,
  latestRevision: 1,
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
};

const fakeAgent: LocalRegisteredAgent = {
  id: "rag_123",
  baseUrl: "https://space.myagents.test",
  spaceId: "space-1",
  workspaceId: "project-1",
  displayName: "Frontend Agent",
  instruction: "Handle frontend issues.",
  instructionRevision: 1,
  subscriptions: [],
  workspacePath: "/tmp/workspace",
  workspaceLabel: "Workspace",
  goalId: "goal-1",
  goalPathLabel: "Runtime",
  stateFilter: ["todo"],
  issueSubscriptionRunMode: "single_session",
  status: "active",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
};

function scoped(id: string): string {
  return `official\n${id}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetSpaceStoreForTest();
  vi.clearAllMocks();
  apiMocks.spaceGetCapability.mockResolvedValue({
    available: true,
    baseUrl: fakeSession.baseUrl,
    publicClientId: null,
    reason: null,
    environments: ["production"],
    activeEnvironment: "production",
  });
  apiMocks.spaceSetActiveSpace.mockResolvedValue(undefined);
  apiMocks.spaceLogout.mockResolvedValue(undefined);
});

describe("spaceStore snapshot", () => {
  it("returns a stable snapshot reference until state changes", () => {
    const first = getSnapshot();
    const second = getSnapshot();

    expect(first).toBe(second);

    __setSpaceStoreStateForTest({
      goals: [
        {
          id: "goal-1",
          spaceId: "space-1",
          parentGoalId: null,
          path: "runtime",
          depth: 0,
          title: "Runtime",
          context: "Runtime work",
          createdAt: "2026-06-24T00:00:00.000Z",
          updatedAt: "2026-06-24T00:00:00.000Z",
        },
      ],
    });

    expect(getSnapshot()).not.toBe(first);
  });
});

describe("spaceStore boot", () => {
  it("uses the stable space slug for API routes even when the session contains a database id", async () => {
    apiMocks.spaceGetSession.mockResolvedValueOnce(fakeSession);
    apiMocks.spaceGetOfficial.mockResolvedValueOnce({
      space: fakeSession.space,
      membership: fakeSession.membership,
      goals: [],
    });

    await actions.ensureBootstrapped({ force: true });

    expect(apiMocks.spaceGetOfficial).toHaveBeenCalledWith("official");
    expect(getSnapshot().spaceId).toBe("official");
  });

  it("clears cached space data when the service origin changes with the same slug", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      serviceBaseUrl: "https://space.myagents.test",
      session: fakeSession,
      spaceId: "official",
      issuesByKey: {
        [scoped("limit=50")]: {
          items: [fakeIssue],
          hasMore: false,
          nextCursor: null,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
      skillDetails: {
        [scoped(fakeSkill.id)]: {
          detail: {
            skill: fakeSkill,
            files: [],
          },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    const devSession: SpaceSession = {
      ...fakeSession,
      baseUrl: "https://space-dev.myagents.test",
    };
    apiMocks.spaceGetCapability.mockResolvedValueOnce({
      available: true,
      baseUrl: devSession.baseUrl,
      publicClientId: null,
      reason: null,
      environments: ["production", "dev"],
      activeEnvironment: "dev",
    });
    apiMocks.spaceGetSession.mockResolvedValueOnce(devSession);
    apiMocks.spaceGetOfficial.mockResolvedValueOnce({
      space: devSession.space,
      membership: devSession.membership,
      goals: [],
    });

    await actions.ensureBootstrapped({ force: true, silent: true });

    const snapshot = getSnapshot();
    expect(snapshot.serviceBaseUrl).toBe(devSession.baseUrl);
    expect(snapshot.session?.baseUrl).toBe(devSession.baseUrl);
    expect(snapshot.spaceId).toBe("official");
    expect(snapshot.issuesByKey).toEqual({});
    expect(snapshot.skillDetails).toEqual({});
  });

  it("invalidates in-flight requests when the service origin changes with the same slug", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      serviceBaseUrl: "https://space.myagents.test",
      session: fakeSession,
      spaceId: "official",
    });
    const pendingIssues = deferred<{
      items: SpaceIssue[];
      hasMore: boolean;
      nextCursor: null;
    }>();
    apiMocks.spaceListIssues.mockReturnValueOnce(pendingIssues.promise);

    const staleRefresh = actions.refreshIssues({ limit: 50 }, { force: true });
    const devSession: SpaceSession = {
      ...fakeSession,
      baseUrl: "https://space-dev.myagents.test",
    };
    apiMocks.spaceGetCapability.mockResolvedValueOnce({
      available: true,
      baseUrl: devSession.baseUrl,
      publicClientId: null,
      reason: null,
      environments: ["production", "dev"],
      activeEnvironment: "dev",
    });
    apiMocks.spaceGetSession.mockResolvedValueOnce(devSession);
    apiMocks.spaceGetOfficial.mockResolvedValueOnce({
      space: devSession.space,
      membership: devSession.membership,
      goals: [],
    });

    await actions.ensureBootstrapped({ force: true, silent: true });
    pendingIssues.resolve({
      items: [fakeIssue],
      hasMore: false,
      nextCursor: null,
    });
    await staleRefresh;

    const snapshot = getSnapshot();
    expect(snapshot.serviceBaseUrl).toBe(devSession.baseUrl);
    expect(snapshot.issuesByKey).toEqual({});
  });

  it("tracks explicit space switches without emitting a second open event", async () => {
    const teamSpace = {
      ...fakeSession.space,
      id: "space-2",
      slug: "team",
      name: "Team Space",
      spaceKind: "team",
    };
    const teamSession: SpaceSession = {
      ...fakeSession,
      lastActiveSpaceId: "team",
      space: teamSpace,
      membership: { id: "membership-2", role: "member" },
    };
    apiMocks.spaceGetSession
      .mockResolvedValueOnce(fakeSession)
      .mockResolvedValueOnce(teamSession);
    apiMocks.spaceGetOfficial
      .mockResolvedValueOnce({
        space: fakeSession.space,
        membership: fakeSession.membership,
        goals: [],
      })
      .mockResolvedValueOnce({
        space: teamSpace,
        membership: teamSession.membership,
        goals: [],
      });

    await actions.ensureBootstrapped({ force: true });
    await actions.switchSpace("team");

    const events = analyticsMocks.track.mock.calls.map((call) => call[0]);
    expect(apiMocks.spaceSetActiveSpace).toHaveBeenCalledWith(
      "team",
      "binding-old",
    );
    expect(events.filter((event) => event === "space_open")).toHaveLength(1);
    expect(events.filter((event) => event === "space_switch")).toHaveLength(1);
  });

  it("projects a listed Space immediately without waiting for Cloud bootstrap", async () => {
    const teamSpace = {
      ...fakeSession.space,
      id: "space-2",
      slug: "team",
      name: "Team Space",
    };
    const teamSession: SpaceSession = {
      ...fakeSession,
      lastActiveSpaceId: "team",
      space: teamSpace,
      membership: { id: "membership-2", role: "member" },
    };
    const listedSession: SpaceSession = {
      ...fakeSession,
      spaces: [
        { ...fakeSession.space, membership: fakeSession.membership },
        { ...teamSpace, membership: teamSession.membership },
      ],
    };
    const pendingPersistence = deferred<SpaceSession | null>();
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: listedSession,
      spaceId: "official",
    });
    apiMocks.spaceSetActiveSpace.mockReturnValueOnce(
      pendingPersistence.promise,
    );

    const switching = actions.switchSpace("team");

    expect(getSnapshot().boot).toBe("ready");
    expect(getSnapshot().session?.space.slug).toBe("team");
    expect(getSnapshot().spaceId).toBe("team");
    expect(apiMocks.spaceGetSession).not.toHaveBeenCalled();

    pendingPersistence.resolve(teamSession);
    await switching;

    expect(getSnapshot().boot).toBe("ready");
    expect(getSnapshot().session?.space.slug).toBe("team");
    expect(apiMocks.spaceGetSession).not.toHaveBeenCalled();
    expect(apiMocks.spaceGetOfficial).not.toHaveBeenCalled();
  });

  it("refreshes goals for the newly projected Space even when bootstrap is fresh", async () => {
    const teamSpace = {
      ...fakeSession.space,
      id: "space-2",
      slug: "team",
      name: "Team Space",
    };
    const teamMembership = { id: "membership-2", role: "member" as const };
    const teamRootGoal = {
      ...fakeGoal,
      id: "goal-team-root",
      spaceId: teamSpace.id,
      path: "/goal-team-root/",
      title: teamSpace.name,
      goalPathLabel: teamSpace.name,
    };
    const bootFetchedAt = Date.now() - 1_000;
    __setSpaceStoreStateForTest({
      boot: "ready",
      bootLastFetchedAt: bootFetchedAt,
      session: {
        ...fakeSession,
        spaces: [
          { ...fakeSession.space, membership: fakeSession.membership },
          { ...teamSpace, membership: teamMembership },
        ],
      },
      spaceId: "official",
      goals: [fakeGoal],
    });
    apiMocks.spaceListGoals.mockResolvedValueOnce({ items: [teamRootGoal] });

    await actions.switchSpace("team");
    await actions.refreshGoals({ maxAgeMs: 30_000 });

    expect(apiMocks.spaceListGoals).toHaveBeenCalledWith({}, "team");
    expect(getSnapshot().goals).toEqual([teamRootGoal]);
    expect(getSnapshot().bootLastFetchedAt).toBe(bootFetchedAt);
    expect(getSnapshot().goalsLastFetchedAt).toBeGreaterThan(bootFetchedAt);
  });

  it("keeps the latest local navigation when persistence fails", async () => {
    const teamSpace = {
      ...fakeSession.space,
      id: "space-2",
      slug: "team",
      name: "Team Space",
    };
    const teamMembership = { id: "membership-2", role: "member" as const };
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: {
        ...fakeSession,
        spaces: [
          { ...fakeSession.space, membership: fakeSession.membership },
          { ...teamSpace, membership: teamMembership },
        ],
      },
      spaceId: "official",
    });
    apiMocks.spaceSetActiveSpace.mockRejectedValueOnce(
      new Error("disk unavailable"),
    );

    const switching = actions.switchSpace("team");

    expect(getSnapshot().session?.space.slug).toBe("team");
    await expect(switching).rejects.toThrow("disk unavailable");
    expect(getSnapshot().session?.space.slug).toBe("team");
  });

  it("adds a newly joined Space from the mutation projection without bootstrap", async () => {
    const joinedSpace = {
      ...fakeSession.space,
      id: "space-joined",
      slug: "joined",
      name: "Joined Space",
      membership: { id: "membership-joined", role: "member" as const },
    };
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: {
        ...fakeSession,
        spaces: [{ ...fakeSession.space, membership: fakeSession.membership }],
      },
      spaceId: "official",
    });

    await actions.switchSpace("joined", joinedSpace);

    expect(getSnapshot().session?.space.slug).toBe("joined");
    expect(getSnapshot().session?.spaces?.map((space) => space.slug)).toEqual([
      "official",
      "joined",
    ]);
    expect(apiMocks.spaceGetSession).not.toHaveBeenCalled();
    expect(apiMocks.spaceGetOfficial).not.toHaveBeenCalled();
  });

  it("serializes persistence while the latest Space intent wins immediately", async () => {
    const teamSpace = {
      ...fakeSession.space,
      id: "space-2",
      slug: "team",
      name: "Team Space",
    };
    const otherSpace = {
      ...fakeSession.space,
      id: "space-3",
      slug: "other",
      name: "Other Space",
    };
    const teamMembership = { id: "membership-2", role: "member" as const };
    const otherMembership = { id: "membership-3", role: "member" as const };
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: {
        ...fakeSession,
        spaces: [
          { ...fakeSession.space, membership: fakeSession.membership },
          { ...teamSpace, membership: teamMembership },
          { ...otherSpace, membership: otherMembership },
        ],
      },
      spaceId: "official",
    });
    const teamPersistence = deferred<SpaceSession | null>();
    apiMocks.spaceSetActiveSpace
      .mockReturnValueOnce(teamPersistence.promise)
      .mockResolvedValueOnce(null);

    const switchToTeam = actions.switchSpace("team");
    const switchToOther = actions.switchSpace("other");
    await Promise.resolve();

    expect(getSnapshot().session?.space.slug).toBe("other");
    expect(apiMocks.spaceSetActiveSpace).toHaveBeenCalledTimes(1);
    expect(apiMocks.spaceSetActiveSpace).toHaveBeenLastCalledWith(
      "team",
      "binding-old",
    );

    teamPersistence.resolve(null);
    await switchToTeam;
    await switchToOther;

    expect(apiMocks.spaceSetActiveSpace).toHaveBeenCalledTimes(2);
    expect(apiMocks.spaceSetActiveSpace).toHaveBeenLastCalledWith(
      "other",
      "binding-old",
    );
    expect(getSnapshot().session?.space.slug).toBe("other");
  });

  it("does not let an old-account persistence queue block the new account", async () => {
    const teamSpace = {
      ...fakeSession.space,
      id: "space-team",
      slug: "team",
      name: "Team Space",
      membership: { id: "membership-team", role: "member" as const },
    };
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: {
        ...fakeSession,
        spaces: [
          { ...fakeSession.space, membership: fakeSession.membership },
          teamSpace,
        ],
      },
      spaceId: "official",
    });
    const oldPersistence = deferred<SpaceSession | null>();
    apiMocks.spaceSetActiveSpace
      .mockReturnValueOnce(oldPersistence.promise)
      .mockResolvedValueOnce(null);

    const oldSwitch = actions.switchSpace("team");
    await vi.waitFor(() =>
      expect(apiMocks.spaceSetActiveSpace).toHaveBeenCalledWith(
        "team",
        "binding-old",
      ),
    );

    const logout = actions.logout();
    expect(getSnapshot().boot).toBe("signedOut");
    await logout;

    const newSession: SpaceSession = {
      ...fakeSession,
      sessionBindingId: "binding-new",
      user: { id: "user-2", email: "other@example.com" },
      spaces: [
        { ...fakeSession.space, membership: fakeSession.membership },
        teamSpace,
      ],
    };
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: newSession,
      spaceId: "official",
    });

    const newSwitch = actions.switchSpace("team");
    await vi.waitFor(() =>
      expect(apiMocks.spaceSetActiveSpace).toHaveBeenCalledWith(
        "team",
        "binding-new",
      ),
    );
    expect(apiMocks.spaceSetActiveSpace).toHaveBeenCalledTimes(2);

    oldPersistence.resolve(null);
    await oldSwitch;
    await newSwitch;
    expect(getSnapshot().session?.user.id).toBe("user-2");
  });
});

describe("spaceStore issue refresh", () => {
  it("keeps related-to-me and unscoped issue caches independent", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const otherIssue = { ...fakeIssue, id: "iss_other", title: "Other" };
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({
        items: [fakeIssue, otherIssue],
        hasMore: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [fakeIssue],
        hasMore: false,
        nextCursor: null,
      });

    await actions.refreshIssues({ limit: 50 }, { force: true });
    await actions.refreshIssues({ related: "me", limit: 50 }, { force: true });

    expect(
      getIssueListState({ limit: 50 }).items.map((item) => item.id),
    ).toEqual([fakeIssue.id, otherIssue.id]);
    expect(getIssueListState({ related: "me", limit: 50 }).items).toEqual([
      fakeIssue,
    ]);
    expect(apiMocks.spaceListIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ related: "me" }),
      "official",
    );
  });

  it("appends and deduplicates cursor pages in the base query cache", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const nextIssue = {
      ...fakeIssue,
      id: "iss_next",
      title: "Next page",
      updatedAt: "2026-06-23T00:00:00.000Z",
    };
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({
        items: [fakeIssue],
        hasMore: true,
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        items: [fakeIssue, nextIssue],
        hasMore: false,
        nextCursor: null,
      });

    await actions.refreshIssues({ related: "me", limit: 50 }, { force: true });
    await actions.loadMoreIssues({ related: "me", limit: 50 });

    expect(apiMocks.spaceListIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        related: "me",
        cursor: "cursor-2",
        limit: 50,
      }),
      "official",
    );
    const list = getIssueListState({ related: "me", limit: 50 });
    expect(list.items.map((item) => item.id)).toEqual([
      fakeIssue.id,
      nextIssue.id,
    ]);
    expect(list.hasMore).toBe(false);
    expect(list.nextCursor).toBeNull();
  });

  it("preserves the explicit all-state contract through refresh and pagination", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const nextIssue = {
      ...fakeIssue,
      id: "iss_done",
      state: "done",
      title: "Completed issue",
      updatedAt: "2026-06-23T00:00:00.000Z",
    };
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({
        items: [fakeIssue],
        hasMore: true,
        nextCursor: "cursor-all-2",
      })
      .mockResolvedValueOnce({
        items: [nextIssue],
        hasMore: false,
        nextCursor: null,
      });

    await actions.refreshIssues({ state: "all", limit: 50 }, { force: true });
    await actions.loadMoreIssues({ state: "all", limit: 50 });

    expect(apiMocks.spaceListIssues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ state: "all", limit: 50 }),
      "official",
    );
    expect(apiMocks.spaceListIssues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        state: "all",
        cursor: "cursor-all-2",
        limit: 50,
      }),
      "official",
    );
    expect(
      getIssueListState({ state: "all", limit: 50 }).items.map(
        (issue) => issue.id,
      ),
    ).toEqual([fakeIssue.id, nextIssue.id]);
  });

  it("dedupes same-key issue refreshes while a request is in flight", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const pending = deferred<{
      items: SpaceIssue[];
      hasMore: boolean;
      nextCursor: null;
    }>();
    apiMocks.spaceListIssues.mockReturnValueOnce(pending.promise);

    const first = actions.refreshIssues(
      { q: " Test ", limit: 50 },
      { maxAgeMs: 30_000 },
    );
    const second = actions.refreshIssues(
      { q: "Test", limit: 50 },
      { maxAgeMs: 30_000 },
    );

    expect(apiMocks.spaceListIssues).toHaveBeenCalledTimes(1);
    expect(apiMocks.spaceListIssues).toHaveBeenCalledWith(
      {
        q: "Test",
        state: undefined,
        goalId: undefined,
        includeSubtree: undefined,
        humanOnly: undefined,
        cursor: undefined,
        limit: 50,
      },
      "official",
    );

    pending.resolve({ items: [fakeIssue], hasMore: false, nextCursor: null });
    await Promise.all([first, second]);

    expect(getIssueListState({ q: "Test", limit: 50 }).items).toEqual([
      fakeIssue,
    ]);
  });

  it("keeps the previous issue list visible when revalidation fails", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [fakeIssue],
      hasMore: false,
      nextCursor: null,
    });

    await actions.refreshIssues({ limit: 50 }, { force: true });
    expect(getIssueListState({ limit: 50 }).items).toEqual([fakeIssue]);

    apiMocks.spaceListIssues.mockRejectedValueOnce(new Error("network down"));

    await expect(
      actions.refreshIssues({ limit: 50 }, { force: true, silent: true }),
    ).rejects.toThrow("network down");

    const state = getIssueListState({ limit: 50 });
    expect(state.items).toEqual([fakeIssue]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBe("network down");
  });

  it("patches current user avatars from the active session after refreshing Space data", async () => {
    const sessionWithAvatar: SpaceSession = {
      ...fakeSession,
      user: {
        ...fakeSession.user,
        name: "I Ethan",
        avatarUrl: "https://r2-public.myagents.test/avatar.png",
      },
    };
    const staleCurrentUser = {
      id: "user-1",
      name: "Old User",
      avatarUrl: null,
    };
    const issueWithStaleAuthor: SpaceIssue = {
      ...fakeIssue,
      creator: staleCurrentUser,
      author: staleCurrentUser,
    };
    const detailWithComment: SpaceIssueDetail = {
      ...fakeDetail,
      issue: issueWithStaleAuthor,
      comments: {
        ...fakeDetail.comments,
        items: [
          {
            id: "comment-1",
            author: {
              id: "user-1",
              type: "user",
              name: "Old User",
              avatarUrl: null,
            },
            body: "same user comment",
            attachments: [],
            createdAt: "2026-06-24T01:00:00.000Z",
          },
        ],
      },
    };
    const skillWithStaleUploader: SpaceSkill = {
      ...fakeSkill,
      uploader: staleCurrentUser,
    };
    __setSpaceStoreStateForTest({ boot: "ready", session: sessionWithAvatar });
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [issueWithStaleAuthor],
      hasMore: false,
      nextCursor: null,
    });
    apiMocks.spaceGetIssue.mockResolvedValueOnce(detailWithComment);
    apiMocks.spaceListSkills.mockResolvedValueOnce({
      items: [skillWithStaleUploader],
    });
    apiMocks.spaceGetSkill.mockResolvedValueOnce({
      skill: skillWithStaleUploader,
      revision: { revision: 1 },
      files: [],
    });
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({
      issue: { ...issueWithStaleAuthor, id: "iss_created", title: "Created" },
    });
    apiMocks.spaceCommentIssue.mockResolvedValueOnce({
      comment: {
        id: "comment-2",
        author: {
          id: "user-1",
          type: "user",
          name: "Old User",
          avatarUrl: null,
        },
        body: "new comment",
        createdAt: "2026-06-24T02:00:00.000Z",
      },
    });

    await actions.refreshIssues({ limit: 50 }, { force: true });
    await actions.refreshIssueDetail("iss_123", { force: true });
    await actions.refreshSkills({ force: true });
    await actions.refreshSkillDetail("skl_123", { force: true });
    const createdIssue = await actions.createIssue({
      title: "Created",
      body: "Body",
    });
    await actions.commentIssue("iss_123", "new comment");

    const snapshot = getSnapshot();
    const refreshedIssue = getIssueListState({ limit: 50 }).items.find(
      (issue) => issue.id === "iss_123",
    );
    expect(refreshedIssue?.creator).toMatchObject({
      name: "I Ethan",
      avatarUrl: sessionWithAvatar.user.avatarUrl,
    });
    expect(refreshedIssue?.author).toMatchObject({
      name: "I Ethan",
      avatarUrl: sessionWithAvatar.user.avatarUrl,
    });
    expect(createdIssue.creator).toMatchObject({
      name: "I Ethan",
      avatarUrl: sessionWithAvatar.user.avatarUrl,
    });
    expect(
      snapshot.issueDetails[scoped("iss_123")]?.detail?.comments.items[0]
        ?.author,
    ).toMatchObject({
      name: "I Ethan",
      avatarUrl: sessionWithAvatar.user.avatarUrl,
    });
    expect(
      snapshot.issueDetails[scoped("iss_123")]?.detail?.comments.items[1]
        ?.author,
    ).toMatchObject({
      name: "I Ethan",
      avatarUrl: sessionWithAvatar.user.avatarUrl,
    });
    expect(snapshot.skills.items[0]?.uploader).toMatchObject({
      name: "I Ethan",
      avatarUrl: sessionWithAvatar.user.avatarUrl,
    });
    expect(
      snapshot.skillDetails[scoped("skl_123")]?.detail?.skill.uploader,
    ).toMatchObject({
      name: "I Ethan",
      avatarUrl: sessionWithAvatar.user.avatarUrl,
    });
  });

  it("prepends a newly created issue into already loaded lists", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [fakeIssue],
      hasMore: false,
      nextCursor: null,
    });
    await actions.refreshIssues({ limit: 50 }, { force: true });

    const newIssue = { ...fakeIssue, id: "iss_456", title: "Second" };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: newIssue });

    await actions.createIssue({ title: "Second", body: "Body" });

    expect(
      getIssueListState({ limit: 50 }).items.map((issue) => issue.id),
    ).toEqual(["iss_456", "iss_123"]);
  });

  it("passes issue draft attachments into the atomic create mutation", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const newIssue = { ...fakeIssue, id: "iss_atomic", attachmentCount: 2 };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: newIssue });

    await actions.createIssue({
      title: "Atomic issue",
      body: "Body",
      filePaths: ["/workspace/one.png", "/workspace/two.log"],
    });

    expect(apiMocks.spaceCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: ["/workspace/one.png", "/workspace/two.log"],
      }),
      "official",
    );
    expect(apiMocks.spaceUploadIssueAttachments).not.toHaveBeenCalled();
  });

  it("does not inject created issues into cached lists with non-matching filters", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const runtimeIssue = {
      ...fakeIssue,
      goalId: "goal-runtime",
      goalPathLabel: "Runtime",
    };
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [runtimeIssue],
      hasMore: false,
      nextCursor: null,
    });
    await actions.refreshIssues(
      { goalId: "goal-runtime", limit: 50 },
      { force: true },
    );

    const uiIssue = {
      ...fakeIssue,
      id: "iss_456",
      title: "UI",
      goalId: "goal-ui",
      goalPathLabel: "UI",
    };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: uiIssue });

    await actions.createIssue({ title: "UI", body: "Body", goalId: "goal-ui" });

    expect(
      getIssueListState({ goalId: "goal-runtime", limit: 50 }).items.map(
        (issue) => issue.id,
      ),
    ).toEqual(["iss_123"]);
  });

  it("matches filtered issue lists by goal id", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const runtimeIssue = {
      ...fakeIssue,
      goalId: "goal-runtime",
      goalPathLabel: "Runtime",
    };
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({
        items: [runtimeIssue],
        hasMore: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        items: [runtimeIssue],
        hasMore: false,
        nextCursor: null,
      });
    await actions.refreshIssues(
      { goalId: "goal-runtime", limit: 50 },
      { force: true },
    );
    await actions.refreshIssues(
      { goalId: "goal-runtime", includeSubtree: true, limit: 50 },
      { force: true },
    );

    const nextIssue = { ...runtimeIssue, id: "iss_456", title: "Patched" };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: nextIssue });

    await actions.createIssue({
      title: nextIssue.title,
      body: nextIssue.body,
      goalId: "goal-runtime",
    });

    expect(
      getIssueListState({ goalId: "goal-runtime", limit: 50 }).items.map(
        (issue) => issue.id,
      ),
    ).toEqual(["iss_456", "iss_123"]);
    expect(
      getIssueListState({
        goalId: "goal-runtime",
        includeSubtree: true,
        limit: 50,
      }).items.map((issue) => issue.id),
    ).toEqual(["iss_456", "iss_123"]);
  });

  it("keeps child-goal issues in cached parent subtree lists after local patches", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      goals: [fakeGoal, fakeChildGoal],
    });
    const childIssue = {
      ...fakeIssue,
      goalId: fakeChildGoal.id,
      goalPathLabel: fakeChildGoal.goalPathLabel,
    };
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({
        items: [childIssue],
        hasMore: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: null });

    await actions.refreshIssues(
      {
        goalId: fakeGoal.id,
        includeSubtree: true,
        state: "todo,doing",
        limit: 50,
      },
      { force: true },
    );
    await actions.refreshIssues(
      { goalId: fakeGoal.id, state: "todo,doing", limit: 50 },
      { force: true },
    );

    apiMocks.spaceSetIssueState.mockResolvedValueOnce({
      state: "doing",
      updatedAt: "2026-06-24T01:00:00.000Z",
    });

    await actions.setIssueState(childIssue.id, "doing");

    expect(
      getIssueListState({
        goalId: fakeGoal.id,
        includeSubtree: true,
        state: "todo,doing",
        limit: 50,
      }).items.map((issue) => `${issue.id}:${issue.state}`),
    ).toEqual(["iss_123:doing"]);
    expect(
      getIssueListState({
        goalId: fakeGoal.id,
        state: "todo,doing",
        limit: 50,
      }).items,
    ).toEqual([]);
  });

  it("moves a state-mutated issue between cached filtered lists", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({
        items: [fakeIssue],
        hasMore: false,
        nextCursor: null,
      })
      .mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: null });

    await actions.refreshIssues({ state: "todo", limit: 50 }, { force: true });
    await actions.refreshIssues({ state: "doing", limit: 50 }, { force: true });

    apiMocks.spaceSetIssueState.mockResolvedValueOnce({
      state: "doing",
      updatedAt: "2026-06-24T01:00:00.000Z",
    });

    await actions.setIssueState("iss_123", "doing");

    expect(getIssueListState({ state: "todo", limit: 50 }).items).toEqual([]);
    expect(
      getIssueListState({ state: "doing", limit: 50 }).items.map(
        (issue) => issue.id,
      ),
    ).toEqual(["iss_123"]);
    expect(
      getIssueListState({ state: "doing", limit: 50 }).items[0]?.state,
    ).toBe("doing");
  });

  it("patches issue detail comments and list counters after a successful comment", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [fakeIssue],
      hasMore: false,
      nextCursor: null,
    });
    await actions.refreshIssues({ limit: 50 }, { force: true });
    __setSpaceStoreStateForTest({
      issueDetails: {
        [scoped("iss_123")]: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    const comment: SpaceIssueComment = {
      id: "cmt_123",
      author: { id: "user-1", type: "user" },
      body: "效果咋样呢？",
      attachments: [
        {
          id: "att_comment_1",
          name: "trace.log",
          sizeBytes: 2048,
          createdAt: "2026-06-24T02:00:00.000Z",
        },
      ],
      createdAt: "2026-06-24T02:00:00.000Z",
    };
    apiMocks.spaceCommentIssue.mockResolvedValueOnce({ comment });

    await actions.commentIssue("iss_123", "效果咋样呢？", [
      "/workspace/trace.log",
    ]);

    const detail = getSnapshot().issueDetails[scoped("iss_123")]?.detail;
    expect(detail?.comments.items).toEqual([comment]);
    expect(detail?.issue.commentCount).toBe(1);
    expect(detail?.issue.attachmentCount).toBe(1);
    expect(apiMocks.spaceCommentIssue).toHaveBeenCalledWith(
      "iss_123",
      "效果咋样呢？",
      ["/workspace/trace.log"],
    );
    expect(getIssueListState({ limit: 50 }).items[0]?.commentCount).toBe(1);
  });

  it("does not patch comments when comment submission fails", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      issueDetails: {
        [scoped("iss_123")]: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceCommentIssue.mockRejectedValueOnce(new Error("network down"));

    await expect(actions.commentIssue("iss_123", "will fail")).rejects.toThrow(
      "network down",
    );

    const detail = getSnapshot().issueDetails[scoped("iss_123")]?.detail;
    expect(detail?.comments.items).toEqual([]);
    expect(detail?.issue.commentCount).toBe(0);
  });

  it("prepends older comment pages with id dedupe", async () => {
    const newest: SpaceIssueComment = {
      id: "cmt_new",
      author: { id: "user-1", type: "user" },
      body: "newest",
      attachments: [],
      createdAt: "2026-06-24T02:00:00.000Z",
    };
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      issueDetails: {
        [scoped("iss_123")]: {
          detail: {
            ...fakeDetail,
            comments: {
              items: [newest],
              hasMore: true,
              nextCursor: "cursor-1",
              limit: 5,
            },
          },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceListIssueComments.mockResolvedValueOnce({
      items: [
        {
          id: "cmt_old",
          author: { id: "user-2", type: "user" },
          body: "older",
          createdAt: "2026-06-24T01:00:00.000Z",
        },
        newest,
      ],
      hasMore: false,
      hasMoreOlder: false,
      nextCursor: null,
      limit: 20,
    });

    await actions.loadOlderIssueComments("iss_123");

    expect(apiMocks.spaceListIssueComments).toHaveBeenCalledWith("iss_123", {
      cursor: "cursor-1",
      limit: 20,
    });
    expect(
      getSnapshot().issueDetails[scoped("iss_123")]?.detail?.comments.items.map(
        (item) => item.id,
      ),
    ).toEqual(["cmt_old", "cmt_new"]);
  });

  it("patches assignee changes and cancellation into detail cache", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      issueDetails: {
        [scoped("iss_123")]: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    const assignedIssue: SpaceIssue = {
      ...fakeIssue,
      assignee: { id: "rag_1", type: "registered_agent", name: "Debugger" },
    };
    apiMocks.spaceSetIssueAssignee.mockResolvedValueOnce({
      issue: assignedIssue,
    });
    await actions.setIssueAssignee("iss_123", {
      type: "registered_agent",
      id: "rag_1",
    });
    expect(
      getSnapshot().issueDetails[scoped("iss_123")]?.detail?.issue.assignee?.id,
    ).toBe("rag_1");

    const reopenedIssue = { ...assignedIssue, assignee: null, state: "todo" };
    apiMocks.spaceCancelIssueAssignee.mockResolvedValueOnce({
      issue: reopenedIssue,
    });
    await actions.cancelIssueAssignee("iss_123");
    expect(
      getSnapshot().issueDetails[scoped("iss_123")]?.detail?.issue.assignee,
    ).toBeNull();
  });

  it("keeps the newest assignee mutation when responses complete out of order", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      issueDetails: {
        [scoped("iss_123")]: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    const first = deferred<{ issue: SpaceIssue }>();
    const secondIssue: SpaceIssue = {
      ...fakeIssue,
      assignee: { id: "rag_new", type: "registered_agent", name: "Newest" },
    };
    apiMocks.spaceSetIssueAssignee
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ issue: secondIssue });

    const firstMutation = actions.setIssueAssignee("iss_123", {
      type: "registered_agent",
      id: "rag_old",
    });
    await actions.setIssueAssignee("iss_123", {
      type: "registered_agent",
      id: "rag_new",
    });
    first.resolve({
      issue: {
        ...fakeIssue,
        assignee: { id: "rag_old", type: "registered_agent", name: "Stale" },
      },
    });
    await firstMutation;

    expect(
      getSnapshot().issueDetails[scoped("iss_123")]?.detail?.issue.assignee?.id,
    ).toBe("rag_new");
  });

  it("keeps list order stable when a remote detail revalidation has a newer timestamp", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const firstIssue = {
      ...fakeIssue,
      id: "iss_first",
      title: "First row",
      updatedAt: "2026-06-24T01:00:00.000Z",
    };
    const secondIssue = {
      ...fakeIssue,
      id: "iss_second",
      title: "Second row",
      updatedAt: "2026-06-24T00:00:00.000Z",
    };
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [firstIssue, secondIssue],
      hasMore: false,
      nextCursor: null,
    });
    await actions.refreshIssues({ limit: 50 }, { force: true });
    apiMocks.spaceGetIssue.mockResolvedValueOnce({
      ...fakeDetail,
      issue: {
        ...secondIssue,
        updatedAt: "2026-06-24T02:00:00.000Z",
      },
    });

    await actions.refreshIssueDetail(secondIssue.id, { force: true });

    expect(
      getIssueListState({ limit: 50 }).items.map((issue) => issue.id),
    ).toEqual([firstIssue.id, secondIssue.id]);
    expect(getIssueListState({ limit: 50 }).items[1]?.updatedAt).toBe(
      "2026-06-24T02:00:00.000Z",
    );
  });

  it("uses the newest uploaded attachment time as the issue update time", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [fakeIssue],
      hasMore: false,
      nextCursor: null,
    });
    await actions.refreshIssues({ limit: 50 }, { force: true });
    __setSpaceStoreStateForTest({
      issueDetails: {
        [scoped(fakeIssue.id)]: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceUploadIssueAttachments.mockResolvedValueOnce({
      attachments: [
        {
          id: "att_1",
          name: "one.txt",
          sizeBytes: 1,
          createdAt: "2026-06-24T02:00:00.000Z",
        },
        {
          id: "att_2",
          name: "two.txt",
          sizeBytes: 2,
          createdAt: "2026-06-24T03:00:00.000Z",
        },
      ],
    });

    await actions.uploadIssueAttachments(fakeIssue.id, [
      "/tmp/one.txt",
      "/tmp/two.txt",
    ]);

    expect(
      getSnapshot().issueDetails[scoped(fakeIssue.id)]?.detail?.issue.updatedAt,
    ).toBe("2026-06-24T03:00:00.000Z");
    expect(getIssueListState({ limit: 50 }).items[0]?.updatedAt).toBe(
      "2026-06-24T03:00:00.000Z",
    );
  });

  it("downloads an issue attachment through the workspace-safe Space command", async () => {
    apiMocks.spaceDownloadIssueAttachment.mockResolvedValueOnce({
      name: "trace.log",
      relativePath:
        "myagents_files/space/issues/iss_123/attachments/att_1/trace.log",
      fullPath:
        "/tmp/workspace/myagents_files/space/issues/iss_123/attachments/att_1/trace.log",
      sizeBytes: 42,
    });

    const result = await actions.downloadIssueAttachment({
      issueId: "iss_123",
      attachmentId: "att_1",
      workspacePath: "/tmp/workspace",
      fileName: "trace.log",
    });

    expect(apiMocks.spaceDownloadIssueAttachment).toHaveBeenCalledWith({
      issueId: "iss_123",
      attachmentId: "att_1",
      workspacePath: "/tmp/workspace",
      fileName: "trace.log",
    });
    expect(result.relativePath).toBe(
      "myagents_files/space/issues/iss_123/attachments/att_1/trace.log",
    );
  });
});

describe("spaceStore goal mutations", () => {
  it("refreshes the goal tree after creating a child goal", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      goals: [fakeGoal],
    });
    const child = {
      ...fakeGoal,
      id: "goal-child",
      parentGoalId: fakeGoal.id,
      path: "/goal-1/goal-child/",
      depth: 1,
      title: "Renderer",
      goalPathLabel: "Runtime / Renderer",
    };
    apiMocks.spaceCreateGoal.mockResolvedValueOnce({ goal: child });
    apiMocks.spaceListGoals.mockResolvedValueOnce({ items: [fakeGoal, child] });

    await actions.createGoal({
      parentGoalId: fakeGoal.id,
      title: child.title,
      context: child.context,
    });

    expect(apiMocks.spaceCreateGoal).toHaveBeenCalledWith(
      { parentGoalId: fakeGoal.id, title: child.title, context: child.context },
      "official",
    );
    expect(getSnapshot().goals.map((goal) => goal.id)).toEqual([
      "goal-1",
      "goal-child",
    ]);
  });

  it("refreshes the goal tree after updating a goal", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      goals: [fakeGoal],
    });
    const updated = {
      ...fakeGoal,
      title: "Runtime Quality",
      context: "Updated runtime work",
      goalPathLabel: "Runtime Quality",
    };
    apiMocks.spaceUpdateGoal.mockResolvedValueOnce({ goal: updated });
    apiMocks.spaceListGoals.mockResolvedValueOnce({ items: [updated] });

    await actions.updateGoal({
      goalId: fakeGoal.id,
      title: updated.title,
      context: updated.context,
    });

    expect(apiMocks.spaceUpdateGoal).toHaveBeenCalledWith({
      goalId: fakeGoal.id,
      title: updated.title,
      context: updated.context,
    });
    expect(getSnapshot().goals[0]?.title).toBe("Runtime Quality");
  });

  it("clears stale issue caches after archiving a goal", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      goals: [fakeGoal],
    });
    apiMocks.spaceListIssues.mockResolvedValueOnce({
      items: [fakeIssue],
      hasMore: false,
      nextCursor: null,
    });
    await actions.refreshIssues({ limit: 50 }, { force: true });
    expect(
      getIssueListState({ limit: 50 }).items.map((issue) => issue.id),
    ).toEqual([fakeIssue.id]);

    apiMocks.spaceArchiveGoal.mockResolvedValueOnce({
      archived: true,
      archivedAt: "2026-06-24T01:00:00.000Z",
    });
    apiMocks.spaceListGoals.mockResolvedValueOnce({ items: [] });

    await actions.archiveGoal(fakeGoal.id);

    expect(apiMocks.spaceArchiveGoal).toHaveBeenCalledWith(fakeGoal.id);
    expect(getSnapshot().goals).toEqual([]);
    expect(getIssueListState({ limit: 50 }).items).toEqual([]);
  });
});

describe("spaceStore profile actions", () => {
  it("updates session and patches current user author summaries in cached Space data", async () => {
    const updatedSession: SpaceSession = {
      ...fakeSession,
      user: {
        ...fakeSession.user,
        name: "Updated User",
        avatarUrl: "https://r2-public.myagents.test/avatar.png",
      },
      updatedAt: "2026-07-05T00:00:00.000Z",
    };
    const issueWithAuthor = {
      ...fakeIssue,
      creator: { id: "user-1", name: "Old User", avatarUrl: null },
      author: { id: "user-1", name: "Old User", avatarUrl: null },
    };
    const detailWithComment: SpaceIssueDetail = {
      ...fakeDetail,
      issue: issueWithAuthor,
      comments: {
        ...fakeDetail.comments,
        items: [
          {
            id: "comment-1",
            author: {
              id: "user-1",
              type: "user",
              name: "Old User",
              avatarUrl: null,
            },
            body: "Profile-linked comment.",
            attachments: [],
            createdAt: "2026-06-24T01:00:00.000Z",
          },
        ],
      },
    };
    const skillWithUploader: SpaceSkill = {
      ...fakeSkill,
      uploader: { id: "user-1", name: "Old User", avatarUrl: null },
    };
    __setSpaceStoreStateForTest({
      session: fakeSession,
      issuesByKey: {
        current: {
          items: [issueWithAuthor],
          hasMore: false,
          nextCursor: null,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
      issueDetails: {
        iss_123: {
          detail: detailWithComment,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
      skills: {
        items: [skillWithUploader],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
      skillDetails: {
        skl_123: {
          detail: {
            skill: skillWithUploader,
            revision: { revision: 1 },
            files: [],
          },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceUpdateProfile.mockResolvedValueOnce(updatedSession);

    await actions.updateProfile({
      name: "Updated User",
      avatarFilePath: "/tmp/avatar.png",
    });

    expect(apiMocks.spaceUpdateProfile).toHaveBeenCalledWith({
      name: "Updated User",
      avatarFilePath: "/tmp/avatar.png",
    });
    const snapshot = getSnapshot();
    expect(snapshot.session?.user).toMatchObject(updatedSession.user);
    expect(snapshot.issuesByKey.current.items[0].creator).toMatchObject({
      name: "Updated User",
      avatarUrl: updatedSession.user.avatarUrl,
    });
    expect(
      snapshot.issueDetails.iss_123.detail?.comments.items[0].author,
    ).toMatchObject({
      name: "Updated User",
      avatarUrl: updatedSession.user.avatarUrl,
    });
    expect(snapshot.skills.items[0].uploader).toMatchObject({
      name: "Updated User",
      avatarUrl: updatedSession.user.avatarUrl,
    });
    expect(snapshot.skillDetails.skl_123.detail?.skill.uploader).toMatchObject({
      name: "Updated User",
      avatarUrl: updatedSession.user.avatarUrl,
    });
  });
});

describe("spaceStore skill actions", () => {
  it("uploads a skill revision and invalidates cached detail/files", async () => {
    const updatedSkill = {
      ...fakeSkill,
      currentRevision: 2,
      latestRevision: 2,
      updatedAt: "2026-06-24T03:00:00.000Z",
    };
    __setSpaceStoreStateForTest({
      skills: {
        items: [fakeSkill],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
      skillDetails: {
        skl_123: {
          detail: { skill: fakeSkill, revision: { revision: 1 }, files: [] },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
      skillFiles: {
        "skl_123\nSKILL.md": {
          text: "# old",
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceUploadSkillZip.mockResolvedValueOnce({ skill: updatedSkill });

    await expect(
      actions.uploadSkillRevision("skl_123", "/tmp/prd-writer.zip"),
    ).resolves.toEqual(updatedSkill);

    expect(apiMocks.spaceUploadSkillZip).toHaveBeenCalledWith({
      filePath: "/tmp/prd-writer.zip",
      skillId: "skl_123",
    });
    expect(getSnapshot().skills.items[0]).toEqual(updatedSkill);
    expect(getSnapshot().skillDetails.skl_123).toBeUndefined();
    expect(getSkillFileState("skl_123", "SKILL.md")).toBeNull();
  });

  it("deletes a skill from list and cached detail state", async () => {
    __setSpaceStoreStateForTest({
      skills: {
        items: [fakeSkill],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
      skillDetails: {
        skl_123: {
          detail: { skill: fakeSkill, revision: { revision: 1 }, files: [] },
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceDeleteSkill.mockResolvedValueOnce({ deleted: true });

    await actions.deleteSkill("skl_123");

    expect(apiMocks.spaceDeleteSkill).toHaveBeenCalledWith("skl_123");
    expect(getSnapshot().skills.items).toEqual([]);
    expect(getSnapshot().skillDetails.skl_123).toBeUndefined();
  });
});

describe("spaceStore registered agent actions", () => {
  it("sorts an explicit Agent refresh but preserves card order during silent presence refresh", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const offline = {
      id: "rag_offline",
      spaceId: "space-1",
      displayName: "Offline",
      status: "active",
      presence: "offline",
      lastOnlineAt: "2026-07-11T10:00:00.000Z",
      createdAt: fakeAgent.createdAt,
      updatedAt: fakeAgent.updatedAt,
    };
    const online = {
      ...offline,
      id: "rag_online",
      displayName: "Online",
      presence: "online",
      lastOnlineAt: "2026-07-11T09:00:00.000Z",
    } as const;
    apiMocks.spaceListRegisteredAgents
      .mockResolvedValueOnce({ items: [offline, online] })
      .mockResolvedValueOnce({
        items: [
          { ...online, presence: "offline" },
          { ...offline, presence: "online" },
        ],
      });

    await actions.refreshRegisteredAgents({ force: true });
    expect(
      getSnapshot().registeredAgents.items.map((agent) => agent.id),
    ).toEqual(["rag_online", "rag_offline"]);

    await actions.refreshRegisteredAgents({ force: true, silent: true });
    expect(
      getSnapshot().registeredAgents.items.map((agent) => agent.id),
    ).toEqual(["rag_online", "rag_offline"]);
    expect(getSnapshot().registeredAgents.items[0].presence).toBe("offline");
  });

  it("patches a registered agent in the local list after update", async () => {
    const updatedAgent = {
      ...fakeAgent,
      status: "disabled",
      updatedAt: "2026-06-24T04:00:00.000Z",
    } satisfies LocalRegisteredAgent;
    __setSpaceStoreStateForTest({
      localAgents: {
        items: [fakeAgent],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
    });
    apiMocks.spaceUpdateRegisteredAgent.mockResolvedValueOnce(updatedAgent);

    await expect(
      actions.updateRegisteredAgent({ id: "rag_123", status: "disabled" }),
    ).resolves.toEqual(updatedAgent);

    expect(apiMocks.spaceUpdateRegisteredAgent).toHaveBeenCalledWith({
      id: "rag_123",
      status: "disabled",
    });
    expect(getSnapshot().localAgents.items).toEqual([updatedAgent]);
  });

  it("preserves Cloud presence when a local Agent edit has no presence projection", async () => {
    const existingSubscription = {
      id: "sub-existing",
      spaceId: fakeAgent.spaceId,
      actorType: "registered_agent" as const,
      actorId: fakeAgent.id,
      goalId: "goal-bugs",
      includeSubtree: true,
      stateFilter: ["todo"],
      goalPathLabel: "Bugs",
      createdAt: fakeAgent.createdAt,
    };
    const updatedAgent = {
      ...fakeAgent,
      displayName: "Renamed Agent",
      subscriptions: [],
      presence: undefined,
      lastOnlineAt: undefined,
      onlineUntil: undefined,
      updatedAt: "2026-06-24T04:00:00.000Z",
    } satisfies LocalRegisteredAgent;
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      localAgents: {
        items: [fakeAgent],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
      registeredAgents: {
        items: [
          {
            id: fakeAgent.id,
            spaceId: fakeAgent.spaceId,
            displayName: fakeAgent.displayName,
            instruction: fakeAgent.instruction,
            instructionRevision: fakeAgent.instructionRevision,
            subscriptions: [existingSubscription],
            status: "active",
            presence: "online",
            lastOnlineAt: "2026-06-24T03:59:00.000Z",
            onlineUntil: "2026-06-24T04:09:00.000Z",
            createdAt: fakeAgent.createdAt,
            updatedAt: fakeAgent.updatedAt,
          },
        ],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
    });
    apiMocks.spaceUpdateRegisteredAgent.mockResolvedValueOnce(updatedAgent);

    await actions.updateRegisteredAgent({
      id: fakeAgent.id,
      displayName: "Renamed Agent",
    });

    expect(getSnapshot().registeredAgents.items[0]).toMatchObject({
      displayName: "Renamed Agent",
      presence: "online",
      lastOnlineAt: "2026-06-24T03:59:00.000Z",
      onlineUntil: "2026-06-24T04:09:00.000Z",
      subscriptions: [existingSubscription],
    });
  });

  it("does not let an older Agent list request overwrite a completed mutation", async () => {
    const staleRefresh = deferred<{
      items: Array<{
        id: string;
        spaceId: string;
        displayName: string;
        status: string;
        presence: "offline";
        createdAt: string;
        updatedAt: string;
      }>;
    }>();
    const updatedAgent = {
      ...fakeAgent,
      displayName: "Mutation wins",
      status: "disabled",
      presence: undefined,
      updatedAt: "2026-06-24T04:00:00.000Z",
    } satisfies LocalRegisteredAgent;
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      localAgents: {
        items: [fakeAgent],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
      registeredAgents: {
        items: [
          {
            id: fakeAgent.id,
            spaceId: fakeAgent.spaceId,
            displayName: fakeAgent.displayName,
            instruction: fakeAgent.instruction,
            instructionRevision: fakeAgent.instructionRevision,
            status: fakeAgent.status,
            presence: "online",
            createdAt: fakeAgent.createdAt,
            updatedAt: fakeAgent.updatedAt,
          },
        ],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
    });
    apiMocks.spaceListRegisteredAgents.mockReturnValueOnce(
      staleRefresh.promise,
    );
    apiMocks.spaceUpdateRegisteredAgent.mockResolvedValueOnce(updatedAgent);

    const refreshPromise = actions.refreshRegisteredAgents({ force: true });
    await actions.updateRegisteredAgent({
      id: fakeAgent.id,
      displayName: "Mutation wins",
      status: "disabled",
    });
    staleRefresh.resolve({
      items: [
        {
          id: fakeAgent.id,
          spaceId: fakeAgent.spaceId,
          displayName: "Stale response",
          status: "active",
          presence: "offline",
          createdAt: fakeAgent.createdAt,
          updatedAt: fakeAgent.updatedAt,
        },
      ],
    });
    await refreshPromise;

    expect(getSnapshot().registeredAgents.items[0]).toMatchObject({
      displayName: "Mutation wins",
      status: "disabled",
      presence: "online",
    });
    expect(getSnapshot().registeredAgents.isLoading).toBe(false);
  });

  it("patches registered agent workspace identity after update", async () => {
    const updatedAgent = {
      ...fakeAgent,
      localWorkspaceId: "project-2",
      workspaceId: "project-2",
      workspacePath: "/tmp/other-workspace",
      workspaceLabel: "Other Workspace",
      updatedAt: "2026-06-24T04:10:00.000Z",
    } satisfies LocalRegisteredAgent;
    __setSpaceStoreStateForTest({
      localAgents: {
        items: [fakeAgent],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
      registeredAgents: {
        items: [
          {
            id: fakeAgent.id,
            spaceId: fakeAgent.spaceId,
            displayName: fakeAgent.displayName,
            instruction: fakeAgent.instruction,
            instructionRevision: fakeAgent.instructionRevision,
            workspacePath: fakeAgent.workspacePath,
            workspaceLabel: fakeAgent.workspaceLabel,
            status: fakeAgent.status,
            createdAt: fakeAgent.createdAt,
            updatedAt: fakeAgent.updatedAt,
          },
        ],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
    });
    apiMocks.spaceUpdateRegisteredAgent.mockResolvedValueOnce(updatedAgent);

    await actions.updateRegisteredAgent({
      id: "rag_123",
      workspaceId: "project-2",
      workspacePath: "/tmp/other-workspace",
      workspaceLabel: "Other Workspace",
    });

    expect(apiMocks.spaceUpdateRegisteredAgent).toHaveBeenCalledWith({
      id: "rag_123",
      workspaceId: "project-2",
      workspacePath: "/tmp/other-workspace",
      workspaceLabel: "Other Workspace",
    });
    expect(getSnapshot().localAgents.items[0]).toMatchObject({
      localWorkspaceId: "project-2",
      workspacePath: "/tmp/other-workspace",
      workspaceLabel: "Other Workspace",
    });
    expect(getSnapshot().registeredAgents.items[0]).toMatchObject({
      localWorkspaceId: "project-2",
      workspacePath: "/tmp/other-workspace",
      workspaceLabel: "Other Workspace",
    });
  });

  it("marks a registered agent as revoked in the local list", async () => {
    const revokedAgent = {
      ...fakeAgent,
      status: "revoked",
      updatedAt: "2026-06-24T04:05:00.000Z",
    } satisfies LocalRegisteredAgent;
    __setSpaceStoreStateForTest({
      localAgents: {
        items: [fakeAgent],
        lastFetchedAt: Date.now(),
        isLoading: false,
        error: null,
      },
    });
    apiMocks.spaceRevokeRegisteredAgent.mockResolvedValueOnce(revokedAgent);

    await actions.revokeRegisteredAgent("rag_123");

    expect(apiMocks.spaceRevokeRegisteredAgent).toHaveBeenCalledWith("rag_123");
    expect(getSnapshot().localAgents.items).toEqual([revokedAgent]);
  });
});

describe("spaceStore event sync", () => {
  it("uses the first event request as a baseline and returns only later events", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const oldEvent: SpaceEvent = {
      id: "evt_1",
      type: "issue.created",
      resourceType: "issue",
      resourceId: "iss_123",
      createdAt: "2026-06-24T01:00:00.000Z",
    };
    const newEvent: SpaceEvent = {
      ...oldEvent,
      id: "evt_2",
      type: "comment.created",
      createdAt: "2026-06-24T02:00:00.000Z",
    };
    const oldCursor = `${oldEvent.createdAt}|${oldEvent.id}`;
    const newCursor = `${newEvent.createdAt}|${newEvent.id}`;
    apiMocks.spaceListEvents
      .mockResolvedValueOnce({
        items: [oldEvent],
        hasMore: false,
        nextCursor: oldCursor,
      })
      .mockResolvedValueOnce({
        items: [newEvent],
        hasMore: false,
        nextCursor: newCursor,
      });

    await expect(actions.syncEvents({ force: true })).resolves.toEqual([]);
    await expect(actions.syncEvents({ force: true })).resolves.toEqual([
      newEvent,
    ]);

    expect(apiMocks.spaceListEvents).toHaveBeenNthCalledWith(
      1,
      { cursor: null, limit: 100, tail: true },
      "official",
    );
    expect(apiMocks.spaceListEvents).toHaveBeenNthCalledWith(
      2,
      { cursor: oldCursor, limit: 100, tail: false },
      "official",
    );
    expect(getSnapshot().events.cursor).toBe(newCursor);
  });

  it("dedupes repeated event ids across cursor windows", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const oldEvent: SpaceEvent = {
      id: "evt_1",
      type: "issue.created",
      resourceType: "issue",
      resourceId: "iss_123",
      createdAt: "2026-06-24T01:00:00.000Z",
    };
    const newEvent: SpaceEvent = {
      ...oldEvent,
      id: "evt_2",
      type: "issue.commented",
      createdAt: "2026-06-24T02:00:00.000Z",
    };
    const oldCursor = `${oldEvent.createdAt}|${oldEvent.id}`;
    const newCursor = `${newEvent.createdAt}|${newEvent.id}`;
    apiMocks.spaceListEvents
      .mockResolvedValueOnce({
        items: [oldEvent],
        hasMore: false,
        nextCursor: oldCursor,
      })
      .mockResolvedValueOnce({
        items: [oldEvent, newEvent],
        hasMore: false,
        nextCursor: newCursor,
      });

    await expect(actions.syncEvents({ force: true })).resolves.toEqual([]);
    await expect(actions.syncEvents({ force: true })).resolves.toEqual([
      newEvent,
    ]);

    expect(getSnapshot().events.items.map((event) => event.id)).toEqual([
      "evt_1",
      "evt_2",
    ]);
  });

  it("keeps composite event cursors so same-timestamp windows can advance by event id", async () => {
    __setSpaceStoreStateForTest({ boot: "ready", session: fakeSession });
    const firstEvent: SpaceEvent = {
      id: "evt_same_001",
      type: "issue.created",
      resourceType: "issue",
      resourceId: "iss_123",
      createdAt: "2026-06-24T01:00:00.000Z",
    };
    const secondEvent: SpaceEvent = {
      ...firstEvent,
      id: "evt_same_002",
      type: "issue.commented",
    };
    const firstCursor = `${firstEvent.createdAt}|${firstEvent.id}`;
    const secondCursor = `${secondEvent.createdAt}|${secondEvent.id}`;
    apiMocks.spaceListEvents
      .mockResolvedValueOnce({
        items: [firstEvent],
        hasMore: true,
        nextCursor: firstCursor,
      })
      .mockResolvedValueOnce({
        items: [secondEvent],
        hasMore: false,
        nextCursor: secondCursor,
      });

    await expect(actions.syncEvents({ force: true })).resolves.toEqual([]);
    await expect(actions.syncEvents({ force: true })).resolves.toEqual([
      secondEvent,
    ]);

    expect(apiMocks.spaceListEvents).toHaveBeenNthCalledWith(
      2,
      { cursor: firstCursor, limit: 100, tail: false },
      "official",
    );
    expect(getSnapshot().events.cursor).toBe(secondCursor);
  });
});

describe("spaceStore cache bounds", () => {
  it("bounds issue detail cache by recency", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      issueDetails: Object.fromEntries(
        Array.from({ length: SPACE_MAX_ISSUE_DETAIL_CACHES }, (_, index) => [
          `iss_old_${index}`,
          {
            detail: {
              ...fakeDetail,
              issue: { ...fakeIssue, id: `iss_old_${index}` },
            },
            lastFetchedAt: index + 1,
            isLoading: false,
            error: null,
          },
        ]),
      ),
    });
    apiMocks.spaceGetIssue.mockResolvedValueOnce({
      ...fakeDetail,
      issue: { ...fakeIssue, id: "iss_new" },
    });

    await actions.refreshIssueDetail("iss_new", { force: true });

    const keys = Object.keys(getSnapshot().issueDetails);
    expect(keys).toHaveLength(SPACE_MAX_ISSUE_DETAIL_CACHES);
    expect(keys).toContain(scoped("iss_new"));
    expect(keys).not.toContain(scoped("iss_old_0"));
  });

  it("bounds skill file cache by recency", async () => {
    __setSpaceStoreStateForTest({
      boot: "ready",
      session: fakeSession,
      skillFiles: Object.fromEntries(
        Array.from({ length: SPACE_MAX_SKILL_FILE_CACHES }, (_, index) => [
          `skl_123\nold-${index}.md`,
          {
            text: `old ${index}`,
            lastFetchedAt: index + 1,
            isLoading: false,
            error: null,
          },
        ]),
      ),
    });
    apiMocks.spaceGetSkillFile.mockResolvedValueOnce({ text: "new file" });

    await actions.refreshSkillFile("skl_123", "new.md", { force: true });

    const keys = Object.keys(getSnapshot().skillFiles);
    expect(keys).toHaveLength(SPACE_MAX_SKILL_FILE_CACHES);
    expect(keys).toContain(scoped("skl_123\nnew.md"));
    expect(keys).not.toContain(scoped("skl_123\nold-0.md"));
  });
});
