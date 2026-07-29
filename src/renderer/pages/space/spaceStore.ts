import {
  DEFAULT_SPACE_ID,
  spaceArchiveGoal,
  spaceCloseOwnIssue,
  spaceCloseIssue,
  spaceCommentIssue,
  spaceCreateGoal,
  spaceCompleteIssue,
  spaceCreateRegisteredAgentSubscription,
  spaceCreateIssue,
  spaceCancelIssueClaim,
  spaceCancelIssueAssignee,
  spaceDeleteSkill,
  spaceDeleteRegisteredAgentSubscription,
  spaceDownloadIssueAttachment,
  spaceGetIssue,
  spaceGetOfficial,
  spaceGetAvatarPresets,
  spaceGetCapability,
  spaceGetSession,
  spaceGetSkill,
  spaceGetSkillFile,
  spaceInstallSkill,
  spaceListSkillRevisions,
  spaceListGoals,
  spaceListIssues,
  spaceListIssueComments,
  spaceListEvents,
  spaceListLocalAgents,
  spaceListRegisteredAgents,
  spaceListSkills,
  spaceLogout,
  spaceRegisterAgent,
  spaceReevaluateRegisteredAgent,
  spaceRevokeRegisteredAgent,
  spaceRollbackSkill,
  spaceSetActiveSpace,
  spaceSetIssueState,
  spaceSetIssueAssignee,
  spaceUpdateProfile,
  spaceUpdateGoal,
  spaceUpdateIssue,
  spaceUpdateRegisteredAgent,
  spaceUpdateRegisteredAgentAvatar,
  spaceUploadIssueAttachments,
  spaceUploadSkillZip,
  type LocalRegisteredAgent,
  type SpaceAvatarPreset,
  type SpaceAttachment,
  type SpaceDownloadAttachmentResult,
  type SpaceEvent,
  type SpaceGoal,
  type SpaceGoalSubscription,
  type SpaceIssue,
  type SpaceIdentitySummary,
  type SpaceIssueDetail,
  type SpaceIssueSubscriptionRunMode,
  type SpaceListItem,
  type SpaceRegisteredAgent,
  type SpaceSession,
  type SpaceSkill,
  type SpaceSkillDetail,
  type SpaceSkillRevisionHistory,
  type SpaceUserSummary,
} from "@/api/spaceCloud";
import type { IssueQueryParams } from "./spaceHelpers";
import {
  buildIssueQueryKey,
  compareRegisteredAgentAvailability,
} from "./spaceHelpers";
import {
  nowForSpaceMetric,
  recordSpaceMetric,
  setSpaceAnalyticsContext,
  trackSpaceOpen,
  trackSpaceSwitch,
  withSpaceMutationMetric,
} from "./spaceMetrics";

export const SPACE_VISIBLE_REFRESH_TTL_MS = 30_000;
export const SPACE_MAX_ISSUE_LIST_CACHES = 20;
export const SPACE_MAX_ISSUE_DETAIL_CACHES = 100;
export const SPACE_MAX_SKILL_DETAIL_CACHES = 100;
export const SPACE_MAX_SKILL_FILE_CACHES = 50;

type BootState = "idle" | "loading" | "ready" | "signedOut" | "error";

export interface SpaceIssueListState {
  items: SpaceIssue[];
  hasMore: boolean;
  nextCursor?: string | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceIssueDetailState {
  detail: SpaceIssueDetail | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceSkillsState {
  items: SpaceSkill[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceSkillDetailState {
  detail: SpaceSkillDetail | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceSkillFileState {
  text: string;
  binary?: boolean;
  mimeType?: string;
  sizeBytes?: number;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceSkillRevisionState {
  history: SpaceSkillRevisionHistory | null;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceAgentsState {
  items: LocalRegisteredAgent[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceRegisteredAgentsState {
  items: SpaceRegisteredAgent[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

export interface SpaceAvatarPresetsState {
  people: SpaceAvatarPreset[];
  agents: SpaceAvatarPreset[];
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface SpaceEventsState {
  items: SpaceEvent[];
  cursor: string | null;
  initialized: boolean;
  lastFetchedAt: number;
  isLoading: boolean;
  error: string | null;
}

interface StoreState {
  boot: BootState;
  serviceBaseUrl: string | null;
  session: SpaceSession | null;
  spaceId: string | null;
  goals: SpaceGoal[];
  goalsLastFetchedAt: number;
  bootError: string | null;
  bootLastFetchedAt: number;
  issuesByKey: Record<string, SpaceIssueListState>;
  issueDetails: Record<string, SpaceIssueDetailState>;
  skills: SpaceSkillsState;
  skillDetails: Record<string, SpaceSkillDetailState>;
  skillFiles: Record<string, SpaceSkillFileState>;
  skillRevisions: Record<string, SpaceSkillRevisionState>;
  localAgents: SpaceAgentsState;
  registeredAgents: SpaceRegisteredAgentsState;
  avatarPresets: SpaceAvatarPresetsState;
  events: SpaceEventsState;
}

export interface SpaceDataSnapshot extends StoreState {
  actions: SpaceActions;
}

interface RefreshOptions {
  force?: boolean;
  silent?: boolean;
  maxAgeMs?: number;
  trackOpen?: boolean;
}

export interface SpaceActions {
  ensureBootstrapped: (options?: RefreshOptions) => Promise<void>;
  switchSpace: (spaceId: string, target?: SpaceListItem) => Promise<void>;
  refreshIssues: (
    params: IssueQueryParams,
    options?: RefreshOptions,
  ) => Promise<void>;
  loadMoreIssues: (params: IssueQueryParams) => Promise<void>;
  refreshGoals: (options?: RefreshOptions) => Promise<void>;
  refreshIssueDetail: (
    issueId: string,
    options?: RefreshOptions,
  ) => Promise<void>;
  refreshSkills: (options?: RefreshOptions) => Promise<void>;
  refreshSkillDetail: (
    skillId: string,
    options?: RefreshOptions,
  ) => Promise<void>;
  refreshSkillFile: (
    skillId: string,
    path: string,
    options?: RefreshOptions,
  ) => Promise<void>;
  refreshSkillRevisions: (
    skillId: string,
    options?: RefreshOptions,
  ) => Promise<void>;
  refreshLocalAgents: (options?: RefreshOptions) => Promise<void>;
  refreshRegisteredAgents: (options?: RefreshOptions) => Promise<void>;
  syncEvents: (options?: RefreshOptions) => Promise<SpaceEvent[]>;
  createGoal: (input: {
    parentGoalId: string;
    title: string;
    context: string;
  }) => Promise<SpaceGoal>;
  updateGoal: (input: {
    goalId: string;
    title: string;
    context: string;
  }) => Promise<SpaceGoal>;
  archiveGoal: (goalId: string) => Promise<void>;
  createIssue: (input: {
    title: string;
    body: string;
    goalId?: string | null;
    humanOnly?: boolean;
    assignee?: { type: "user" | "registered_agent"; id: string } | null;
    filePaths?: string[];
  }) => Promise<SpaceIssue>;
  updateIssue: (input: {
    issueId: string;
    title?: string;
    body?: string;
    goalId?: string | null;
  }) => Promise<SpaceIssue>;
  loadOlderIssueComments: (issueId: string) => Promise<void>;
  setIssueAssignee: (
    issueId: string,
    assignee: { type: "user" | "registered_agent"; id: string },
  ) => Promise<SpaceIssue>;
  cancelIssueAssignee: (issueId: string) => Promise<SpaceIssue>;
  uploadIssueAttachments: (
    issueId: string,
    filePaths: string[],
  ) => Promise<SpaceAttachment[]>;
  downloadIssueAttachment: (input: {
    issueId: string;
    attachmentId: string;
    workspacePath: string;
    fileName?: string;
    output?: string;
  }) => Promise<SpaceDownloadAttachmentResult>;
  commentIssue: (
    issueId: string,
    body: string,
    filePaths?: string[],
  ) => Promise<void>;
  setIssueState: (issueId: string, state: string) => Promise<void>;
  closeOwnIssue: (issueId: string) => Promise<void>;
  closeIssue: (issueId: string) => Promise<void>;
  completeIssue: (issueId: string) => Promise<void>;
  cancelIssueClaim: (issueId: string) => Promise<void>;
  updateProfile: (input: {
    name: string;
    avatarFilePath?: string | null;
    avatarPresetId?: string | null;
    nameChanged?: boolean;
  }) => Promise<void>;
  loadAvatarPresets: (options?: RefreshOptions) => Promise<void>;
  uploadSkillZip: (input: {
    filePath: string;
    name?: string;
    description?: string;
    skillId?: string;
    source?: SpaceSkill["source"];
  }) => Promise<SpaceSkill>;
  uploadSkillRevision: (
    skillId: string,
    filePath: string,
    source?: SpaceSkill["source"],
  ) => Promise<SpaceSkill>;
  rollbackSkill: (skillId: string, revision: number) => Promise<SpaceSkill>;
  deleteSkill: (skillId: string) => Promise<void>;
  installSkill: (input: {
    skillId: string;
    skillName: string;
    target: "global" | "project";
    workspacePath?: string;
    overwrite?: boolean;
  }) => Promise<{
    installedName: string;
    installedPath: string;
    target: string;
  }>;
  registerAgent: (input: {
    displayName: string;
    instruction: string;
    workspaceId: string;
    workspacePath: string;
    workspaceLabel?: string;
    goalId: string;
    stateFilter?: string[];
    issueSubscriptionRunMode?: SpaceIssueSubscriptionRunMode;
  }) => Promise<LocalRegisteredAgent>;
  updateRegisteredAgent: (input: {
    id: string;
    displayName?: string;
    instruction?: string;
    expectedInstructionRevision?: number;
    workspaceId?: string;
    workspacePath?: string;
    workspaceLabel?: string;
    goalId?: string;
    stateFilter?: string[];
    status?: "active" | "disabled";
    issueSubscriptionRunMode?: SpaceIssueSubscriptionRunMode;
  }) => Promise<LocalRegisteredAgent>;
  createRegisteredAgentSubscription: (input: {
    registeredAgentId: string;
    goalId: string;
    stateFilter: string[];
  }) => Promise<SpaceGoalSubscription>;
  deleteRegisteredAgentSubscription: (subscriptionId: string) => Promise<void>;
  reevaluateRegisteredAgent: (id: string) => Promise<number>;
  updateRegisteredAgentAvatar: (input: {
    id: string;
    avatarFilePath?: string | null;
    avatarPresetId?: string | null;
  }) => Promise<LocalRegisteredAgent>;
  revokeRegisteredAgent: (id: string) => Promise<LocalRegisteredAgent>;
  logout: () => Promise<void>;
}

const EMPTY_ISSUE_LIST: SpaceIssueListState = {
  items: [],
  hasMore: false,
  nextCursor: null,
  lastFetchedAt: 0,
  isLoading: false,
  error: null,
};

const initialState = (): StoreState => ({
  boot: "idle",
  serviceBaseUrl: null,
  session: null,
  spaceId: null,
  goals: [],
  goalsLastFetchedAt: 0,
  bootError: null,
  bootLastFetchedAt: 0,
  issuesByKey: {},
  issueDetails: {},
  skills: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  skillDetails: {},
  skillFiles: {},
  skillRevisions: {},
  localAgents: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  registeredAgents: {
    items: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  avatarPresets: {
    people: [],
    agents: [],
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
  events: {
    items: [],
    cursor: null,
    initialized: false,
    lastFetchedAt: 0,
    isLoading: false,
    error: null,
  },
});

let state: StoreState = initialState();
const listeners = new Set<() => void>();
let snapshot!: SpaceDataSnapshot;
let bootPromise: Promise<void> | null = null;
let activeSpacePersistenceQueue: Promise<void> = Promise.resolve();
let activeSpacePersistenceBinding: string | null = null;
let seq = 0;
const latestSeqByKey = new Map<string, number>();
const inFlightRequests = new Map<string, Promise<void>>();

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildSnapshot(): SpaceDataSnapshot {
  return { ...state, actions };
}

function emit(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function applyServiceBaseUrl(
  serviceBaseUrl: string | null,
  preserveBootSeq?: number,
): void {
  if (!serviceBaseUrl) return;
  if (state.serviceBaseUrl === serviceBaseUrl) return;
  if (state.serviceBaseUrl) {
    invalidatePendingRequests({ preserveBootSeq });
    state = { ...initialState(), boot: state.boot, serviceBaseUrl };
    emit();
    return;
  }
  setState({ serviceBaseUrl });
}

function startRequest(key: string): number {
  const next = ++seq;
  latestSeqByKey.set(key, next);
  return next;
}

function isLatest(key: string, requestSeq: number): boolean {
  return latestSeqByKey.get(key) === requestSeq;
}

function invalidateRegisteredAgentReads(): void {
  startRequest("registered-agents");
  inFlightRequests.delete("registered-agents");
}

function isFresh(lastFetchedAt: number, maxAgeMs?: number): boolean {
  return Boolean(
    maxAgeMs && lastFetchedAt > 0 && Date.now() - lastFetchedAt < maxAgeMs,
  );
}

function trimCacheRecord<
  T extends { lastFetchedAt: number; isLoading: boolean },
>(record: Record<string, T>, maxEntries: number): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= maxEntries) return record;
  return Object.fromEntries(
    entries
      .sort(([, a], [, b]) => {
        if (a.isLoading !== b.isLoading) return a.isLoading ? -1 : 1;
        return b.lastFetchedAt - a.lastFetchedAt;
      })
      .slice(0, maxEntries),
  );
}

function ensureReady(): boolean {
  return state.boot === "ready" && Boolean(state.session);
}

function spaceRouteSegment(space?: SpaceSession["space"] | null): string {
  return space?.slug || space?.id || DEFAULT_SPACE_ID;
}

function activeSpaceId(): string {
  return state.spaceId || spaceRouteSegment(state.session?.space);
}

function spaceMatchesRoute(
  space: SpaceSession["space"],
  route: string,
): boolean {
  return space.id === route || space.slug === route;
}

function resolveSpaceSwitchTarget(
  route: string,
  explicitTarget?: SpaceListItem,
): SpaceListItem | null {
  if (explicitTarget && spaceMatchesRoute(explicitTarget, route)) {
    return explicitTarget;
  }
  return (
    state.session?.spaces?.find((space) => spaceMatchesRoute(space, route)) ??
    null
  );
}

function upsertSessionSpace(
  spaces: SpaceListItem[] | undefined,
  target: SpaceListItem,
): SpaceListItem[] {
  const current = spaces ?? [];
  const index = current.findIndex(
    (space) => space.id === target.id || space.slug === target.slug,
  );
  if (index < 0) return [...current, target];
  return current.map((space, itemIndex) =>
    itemIndex === index ? target : space,
  );
}

function spaceInfoFromListItem(target: SpaceListItem): SpaceSession["space"] {
  const { membership, canManage, pendingJoinRequestCount, ...space } = target;
  void membership;
  void canManage;
  void pendingJoinRequestCount;
  return space;
}

function projectActiveSpace(route: string, target: SpaceListItem): void {
  const session = state.session;
  if (!session) return;
  const serviceBaseUrl = state.serviceBaseUrl || session.baseUrl.trim() || null;
  const bootLastFetchedAt = state.bootLastFetchedAt;
  invalidatePendingRequests();
  state = {
    ...initialState(),
    boot: "ready",
    serviceBaseUrl,
    session: {
      ...session,
      space: spaceInfoFromListItem(target),
      membership: target.membership,
      spaces: upsertSessionSpace(session.spaces, target),
      lastActiveSpaceId: route,
    },
    spaceId: spaceRouteSegment(target),
    bootLastFetchedAt,
  };
  emit();
  setSpaceAnalyticsContext({
    spaceKind: target.spaceKind ?? null,
    role: target.membership.role,
  });
}

function persistActiveSpace(
  route: string,
  sessionBindingId: string,
): Promise<void> {
  if (activeSpacePersistenceBinding !== sessionBindingId) {
    activeSpacePersistenceBinding = sessionBindingId;
    activeSpacePersistenceQueue = Promise.resolve();
  }
  const persistence = activeSpacePersistenceQueue.then(async () => {
    await spaceSetActiveSpace(route, sessionBindingId);
  });
  activeSpacePersistenceQueue = persistence.catch(() => undefined);
  return persistence;
}

function scopedKey(key: string): string {
  return `${activeSpaceId()}\n${key}`;
}

function unscopedKey(key: string): string {
  const separator = key.indexOf("\n");
  return separator === -1 ? key : key.slice(separator + 1);
}

function runRequest(
  key: string,
  force: boolean | undefined,
  task: () => Promise<void>,
): Promise<void> {
  if (!force) {
    const existing = inFlightRequests.get(key);
    if (existing) return existing;
  }
  const promise = task().finally(() => {
    if (inFlightRequests.get(key) === promise) {
      inFlightRequests.delete(key);
    }
  });
  inFlightRequests.set(key, promise);
  return promise;
}

function invalidatePendingRequests(
  options: { preserveBootSeq?: number } = {},
): void {
  seq += 1;
  if (options.preserveBootSeq === undefined) {
    bootPromise = null;
  }
  latestSeqByKey.clear();
  if (options.preserveBootSeq !== undefined) {
    latestSeqByKey.set("boot", options.preserveBootSeq);
  }
  inFlightRequests.clear();
}

function normalizeIssueQueryParams(params: IssueQueryParams): IssueQueryParams {
  return {
    q: params.q?.trim() || undefined,
    state: params.state?.trim() || undefined,
    goalId: params.goalId?.trim() || undefined,
    includeSubtree: params.includeSubtree,
    humanOnly: params.humanOnly,
    related: params.related,
    cursor: params.cursor?.trim() || undefined,
    limit: params.limit ?? 50,
  };
}

function compareUpdatedDesc(
  left: Pick<SpaceIssue | SpaceSkill, "id" | "updatedAt">,
  right: Pick<SpaceIssue | SpaceSkill, "id" | "updatedAt">,
): number {
  const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (Number.isFinite(updatedDelta) && updatedDelta !== 0) return updatedDelta;
  return right.id.localeCompare(left.id);
}

function mergeRegisteredAgentsPreservingOrder(
  previous: SpaceRegisteredAgent[],
  incoming: SpaceRegisteredAgent[],
): SpaceRegisteredAgent[] {
  if (previous.length === 0) {
    return [...incoming].sort(compareRegisteredAgentAvailability);
  }
  const incomingById = new Map(incoming.map((agent) => [agent.id, agent]));
  const merged = previous.flatMap((agent) => {
    const next = incomingById.get(agent.id);
    if (!next) return [];
    incomingById.delete(agent.id);
    return [next];
  });
  return [
    ...merged,
    ...[...incomingById.values()].sort(compareRegisteredAgentAvailability),
  ];
}

function goalMatchesFilter(
  issueGoalId: string | null | undefined,
  goalId: string,
  includeSubtree: boolean,
): boolean {
  const normalizedIssueGoalId = issueGoalId?.trim();
  if (goalId === "inbox" || goalId === "null") return !normalizedIssueGoalId;
  if (!normalizedIssueGoalId) return false;
  if (normalizedIssueGoalId === goalId) return true;
  if (!includeSubtree) return false;

  const goalsById = new Map(state.goals.map((goal) => [goal.id, goal]));
  let current = goalsById.get(normalizedIssueGoalId);
  const visited = new Set<string>();
  for (let depth = 0; current && depth < 64; depth += 1) {
    const currentId = current.id;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const parentGoalId = current.parentGoalId?.trim();
    if (!parentGoalId) return false;
    if (parentGoalId === goalId) return true;
    current = goalsById.get(parentGoalId);
  }

  return false;
}

function issueHasDirectCurrentAccountRelation(issue: SpaceIssue): boolean {
  const userId = state.session?.user.id;
  if (!userId) return false;
  const ownedAgentIds = new Set(
    state.registeredAgents.items
      .filter((agent) => agent.ownerUserId === userId)
      .map((agent) => agent.id),
  );
  const creatorId =
    issue.createdByUserId ??
    issue.creator?.id ??
    issue.author?.id ??
    issue.createdById;
  if (creatorId === userId || (creatorId && ownedAgentIds.has(creatorId))) {
    return true;
  }
  const claimActorId = issue.claim?.actorId ?? issue.claim?.actor?.id;
  return Boolean(
    claimActorId === userId ||
      (claimActorId && ownedAgentIds.has(claimActorId)),
  );
}

function issueMatchesListKey(
  issue: SpaceIssue,
  key: string,
  relationAlreadyKnown = false,
): boolean {
  const params = new URLSearchParams(unscopedKey(key));
  const cursor = params.get("cursor")?.trim();
  if (cursor) return false;

  const state = params.get("state")?.trim();
  if (
    state &&
    state !== "all" &&
    !state.split(",").some((item) => item.trim() === issue.state)
  )
    return false;

  const goalId = params.get("goalId")?.trim();
  if (
    goalId &&
    !goalMatchesFilter(
      issue.goalId,
      goalId,
      params.get("includeSubtree") === "true",
    )
  )
    return false;

  const humanOnly = params.get("humanOnly")?.trim();
  if (humanOnly === "true" && !issue.humanOnly) return false;
  if (humanOnly === "false" && issue.humanOnly) return false;

  const q = params.get("q")?.trim().toLowerCase();
  if (q && !issue.title.toLowerCase().includes(q)) return false;

  if (
    params.get("related") === "me" &&
    !relationAlreadyKnown &&
    !issueHasDirectCurrentAccountRelation(issue)
  ) {
    return false;
  }

  return true;
}

export function getIssueListState(
  params: IssueQueryParams,
): SpaceIssueListState {
  return (
    state.issuesByKey[scopedKey(buildIssueQueryKey(params))] ?? EMPTY_ISSUE_LIST
  );
}

function patchIssueInLists(
  issue: SpaceIssue,
  options: {
    establishesCurrentAccountRelation?: boolean;
    preserveOrder?: boolean;
  } = {},
): void {
  const { establishesCurrentAccountRelation = false, preserveOrder = false } =
    options;
  const detailKey = scopedKey(issue.id);
  const issuesByKey = Object.fromEntries(
    Object.entries(state.issuesByKey).map(([key, slice]) => {
      if (preserveOrder) {
        return [
          key,
          {
            ...slice,
            items: slice.items.map((item) =>
              item.id === issue.id ? { ...item, ...issue } : item,
            ),
          },
        ];
      }
      const items = slice.items.flatMap((item) => {
        if (item.id !== issue.id) return [item];
        const next = { ...item, ...issue };
        return issueMatchesListKey(next, key, true) ? [next] : [];
      });
      const hasIssue = items.some((item) => item.id === issue.id);
      return [
        key,
        {
          ...slice,
          items: (!hasIssue &&
          issueMatchesListKey(issue, key, establishesCurrentAccountRelation)
            ? [issue, ...items]
            : items
          ).sort(compareUpdatedDesc),
        },
      ];
    }),
  );
  const existingDetail = state.issueDetails[detailKey];
  const issueDetails = existingDetail?.detail
    ? {
        ...state.issueDetails,
        [detailKey]: {
          ...existingDetail,
          detail: {
            ...existingDetail.detail,
            issue: { ...existingDetail.detail.issue, ...issue },
          },
        },
      }
    : state.issueDetails;
  setState({ issuesByKey, issueDetails });
}

function prependIssueToLists(issue: SpaceIssue): void {
  const issuesByKey = Object.fromEntries(
    Object.entries(state.issuesByKey).map(([key, slice]) => {
      if (!issueMatchesListKey(issue, key)) return [key, slice];
      const withoutDuplicate = slice.items.filter(
        (item) => item.id !== issue.id,
      );
      return [
        key,
        {
          ...slice,
          items: [issue, ...withoutDuplicate].sort(compareUpdatedDesc),
        },
      ];
    }),
  );
  setState({ issuesByKey });
}

function patchIssueDetail(
  issueId: string,
  patch: (detail: SpaceIssueDetail) => SpaceIssueDetail,
): void {
  const key = scopedKey(issueId);
  const current = state.issueDetails[key];
  if (!current?.detail) return;
  setState({
    issueDetails: {
      ...state.issueDetails,
      [key]: { ...current, detail: patch(current.detail) },
    },
  });
}

function detailKey(id: string): string {
  return scopedKey(id);
}

function skillFileKey(skillId: string, path: string): string {
  return scopedKey(`${skillId}\n${path}`);
}

function localAgentToRegisteredAgent(
  agent: LocalRegisteredAgent,
): SpaceRegisteredAgent {
  return {
    id: agent.id,
    spaceId: agent.spaceId,
    ownerUserId: agent.ownerUserId,
    deviceId: agent.deviceId,
    device: agent.device,
    clientId: agent.clientId,
    deviceName: agent.deviceName,
    localWorkspaceId: agent.localWorkspaceId,
    localAgentId: agent.localAgentId,
    displayName: agent.displayName,
    instruction: agent.instruction ?? null,
    instructionRevision: agent.instructionRevision,
    workspacePath: agent.workspacePath,
    workspaceLabel: agent.workspaceLabel,
    avatarUrl: agent.avatarUrl ?? null,
    avatarSource: agent.avatarSource ?? null,
    avatarPresetId: agent.avatarPresetId ?? null,
    avatarUrls: agent.avatarUrls ?? null,
    subscriptions: agent.subscriptions,
    goalMd: agent.goalMd,
    issueSubscriptionRunMode: agent.issueSubscriptionRunMode,
    status: agent.status,
    ...(agent.presence
      ? {
          presence: agent.presence,
          lastOnlineAt: agent.lastOnlineAt,
          onlineUntil: agent.onlineUntil,
        }
      : {}),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function patchUserSummary<T extends SpaceUserSummary | null | undefined>(
  summary: T,
  user: SpaceSession["user"],
): T {
  if (!summary || summary.id !== user.id) return summary;
  const next = { ...summary };
  if (Object.prototype.hasOwnProperty.call(user, "name")) {
    next.name = user.name ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(user, "avatarUrl")) {
    next.avatarUrl = user.avatarUrl ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(user, "avatarPresetId")) {
    next.avatarPresetId = user.avatarPresetId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(user, "avatarUrls")) {
    next.avatarUrls = user.avatarUrls ?? null;
  }
  return {
    ...next,
  } as T;
}

function currentUserSummary(user: SpaceSession["user"]): SpaceIdentitySummary {
  const summary: SpaceIdentitySummary = { id: user.id, type: "user" };
  if (Object.prototype.hasOwnProperty.call(user, "name")) {
    summary.name = user.name ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(user, "avatarUrl")) {
    summary.avatarUrl = user.avatarUrl ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(user, "avatarPresetId")) {
    summary.avatarPresetId = user.avatarPresetId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(user, "avatarUrls")) {
    summary.avatarUrls = user.avatarUrls ?? null;
  }
  return summary;
}

function patchIssueAuthorSummaries(
  issue: SpaceIssue,
  user: SpaceSession["user"],
): SpaceIssue {
  const currentUser = currentUserSummary(user);
  return {
    ...issue,
    creator: issue.creator
      ? patchUserSummary(issue.creator, user)
      : issue.createdByUserId === user.id
        ? currentUser
        : issue.creator,
    author: patchUserSummary(issue.author, user),
  };
}

function patchIssueDetailAuthorSummaries(
  detail: SpaceIssueDetail,
  user: SpaceSession["user"],
): SpaceIssueDetail {
  return {
    ...detail,
    issue: patchIssueAuthorSummaries(detail.issue, user),
    comments: {
      ...detail.comments,
      items: detail.comments.items.map((comment) => ({
        ...comment,
        author: patchUserSummary(comment.author, user),
      })),
    },
  };
}

function registeredAgentSummary(
  agent: LocalRegisteredAgent,
): SpaceIdentitySummary {
  return {
    id: agent.id,
    type: "registered_agent",
    name: agent.displayName,
    avatarUrl: agent.avatarUrl ?? null,
    avatarPresetId: agent.avatarPresetId ?? null,
    avatarUrls: agent.avatarUrls ?? null,
  };
}

function patchRegisteredAgentSummary<
  T extends SpaceUserSummary | null | undefined,
>(summary: T, agent: LocalRegisteredAgent): T {
  if (!summary || summary.id !== agent.id) return summary;
  return {
    ...summary,
    ...registeredAgentSummary(agent),
  } as T;
}

function patchIssueRegisteredAgentAuthor(
  issue: SpaceIssue,
  agent: LocalRegisteredAgent,
): SpaceIssue {
  if (
    issue.createdByType !== "registered_agent" &&
    issue.creator?.id !== agent.id
  ) {
    return issue;
  }
  return {
    ...issue,
    creator:
      issue.creator?.id === agent.id || issue.createdById === agent.id
        ? (patchRegisteredAgentSummary(issue.creator, agent) ??
          registeredAgentSummary(agent))
        : issue.creator,
    author: patchRegisteredAgentSummary(issue.author, agent),
  };
}

function patchIssueDetailRegisteredAgentAuthor(
  detail: SpaceIssueDetail,
  agent: LocalRegisteredAgent,
): SpaceIssueDetail {
  return {
    ...detail,
    issue: patchIssueRegisteredAgentAuthor(detail.issue, agent),
    comments: {
      ...detail.comments,
      items: detail.comments.items.map((comment) => ({
        ...comment,
        author:
          comment.author.type === "registered_agent" &&
          comment.author.id === agent.id
            ? {
                ...comment.author,
                name: agent.displayName,
                avatarUrl: agent.avatarUrl ?? null,
              }
            : comment.author,
      })),
    },
  };
}

function patchSkillUploader(
  skill: SpaceSkill,
  user: SpaceSession["user"],
): SpaceSkill {
  return {
    ...skill,
    uploader: patchUserSummary(skill.uploader, user),
  };
}

function patchSkillDetailUploader(
  detail: SpaceSkillDetail,
  user: SpaceSession["user"],
): SpaceSkillDetail {
  return {
    ...detail,
    skill: patchSkillUploader(detail.skill, user),
  };
}

function patchProfileInCaches(session: SpaceSession) {
  const user = session.user;
  setState({
    session,
    issuesByKey: Object.fromEntries(
      Object.entries(state.issuesByKey).map(([key, list]) => [
        key,
        {
          ...list,
          items: list.items.map((issue) =>
            patchIssueAuthorSummaries(issue, user),
          ),
        },
      ]),
    ),
    issueDetails: Object.fromEntries(
      Object.entries(state.issueDetails).map(([key, detailState]) => [
        key,
        detailState.detail
          ? {
              ...detailState,
              detail: patchIssueDetailAuthorSummaries(detailState.detail, user),
            }
          : detailState,
      ]),
    ),
    skills: {
      ...state.skills,
      items: state.skills.items.map((skill) => patchSkillUploader(skill, user)),
    },
    skillDetails: Object.fromEntries(
      Object.entries(state.skillDetails).map(([key, detailState]) => [
        key,
        detailState.detail
          ? {
              ...detailState,
              detail: patchSkillDetailUploader(detailState.detail, user),
            }
          : detailState,
      ]),
    ),
    skillRevisions: Object.fromEntries(
      Object.entries(state.skillRevisions).map(([key, revisionState]) => [
        key,
        revisionState.history
          ? {
              ...revisionState,
              history: {
                ...revisionState.history,
                items: revisionState.history.items.map((revision) => ({
                  ...revision,
                  uploader: patchUserSummary(revision.uploader, user),
                })),
              },
            }
          : revisionState,
      ]),
    ),
  });
}

export const actions: SpaceActions = {
  ensureBootstrapped: async (options: RefreshOptions = {}) => {
    if (
      !options.force &&
      (state.boot === "ready" || state.boot === "signedOut") &&
      (!options.maxAgeMs || isFresh(state.bootLastFetchedAt, options.maxAgeMs))
    ) {
      return;
    }
    if (bootPromise && !options.force) return bootPromise;
    if (!options.silent) setState({ boot: "loading", bootError: null });
    const requestSeq = startRequest("boot");
    bootPromise = (async () => {
      const startedAt = nowForSpaceMetric();
      recordSpaceMetric("space_boot_start");
      try {
        const capability = await spaceGetCapability();
        if (!isLatest("boot", requestSeq)) return;
        applyServiceBaseUrl(capability.baseUrl?.trim() || null, requestSeq);
        const session = await spaceGetSession();
        if (!isLatest("boot", requestSeq)) return;
        applyServiceBaseUrl(session?.baseUrl?.trim() || null, requestSeq);
        if (!session) {
          setSpaceAnalyticsContext(null);
          setState({
            ...initialState(),
            serviceBaseUrl: capability.baseUrl?.trim() || null,
            boot: "signedOut",
            bootLastFetchedAt: Date.now(),
          });
          return;
        }
        const preferredSpaceId =
          session.lastActiveSpaceId || spaceRouteSegment(session.space);
        const official = await spaceGetOfficial(preferredSpaceId).catch(
          (error) => {
            if (preferredSpaceId === DEFAULT_SPACE_ID) throw error;
            return spaceGetOfficial(DEFAULT_SPACE_ID);
          },
        );
        if (!isLatest("boot", requestSeq)) return;
        const nextSpaceId = spaceRouteSegment(official.space || session.space);
        const previousBoot = state.boot;
        const previousSpaceId = state.spaceId;
        const spaceChanged = Boolean(
          state.spaceId && state.spaceId !== nextSpaceId,
        );
        if (spaceChanged) {
          state = {
            ...initialState(),
            boot: state.boot,
            serviceBaseUrl:
              session.baseUrl.trim() || capability.baseUrl?.trim() || null,
          };
        }
        setState({
          boot: "ready",
          serviceBaseUrl:
            session.baseUrl.trim() || capability.baseUrl?.trim() || null,
          session: {
            ...session,
            space: {
              ...official.space,
              limits: official.limits ?? official.space.limits,
              usage: official.usage ?? official.space.usage,
            },
            membership: official.membership,
          },
          spaceId: nextSpaceId,
          goals: official.goals ?? [],
          goalsLastFetchedAt: Date.now(),
          bootError: null,
          bootLastFetchedAt: Date.now(),
        });
        setSpaceAnalyticsContext({
          spaceKind:
            official.space?.spaceKind ?? session.space?.spaceKind ?? null,
          role: official.membership?.role ?? session.membership?.role ?? null,
        });
        if (
          options.trackOpen !== false &&
          !options.silent &&
          (previousBoot !== "ready" || previousSpaceId !== nextSpaceId)
        ) {
          trackSpaceOpen("home");
        }
        recordSpaceMetric("space_boot_end", {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: true,
        });
      } catch (error) {
        if (!isLatest("boot", requestSeq)) return;
        if (
          options.silent &&
          (state.boot === "ready" || state.boot === "signedOut")
        ) {
          setState({ bootError: errMessage(error) });
          recordSpaceMetric("space_boot_end", {
            durationMs: Math.round(nowForSpaceMetric() - startedAt),
            ok: false,
            error: errMessage(error),
          });
          return;
        }
        setState({
          boot: "error",
          bootError: errMessage(error),
        });
        recordSpaceMetric("space_boot_end", {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: false,
          error: errMessage(error),
        });
      } finally {
        if (isLatest("boot", requestSeq)) bootPromise = null;
      }
    })();
    return bootPromise;
  },

  switchSpace: async (spaceId: string, explicitTarget?: SpaceListItem) => {
    const trimmed = spaceId.trim();
    if (!trimmed || trimmed === activeSpaceId()) return;
    const target = resolveSpaceSwitchTarget(trimmed, explicitTarget);
    const sessionBindingId = state.session?.sessionBindingId?.trim();
    if (target) {
      projectActiveSpace(trimmed, target);
    } else {
      invalidatePendingRequests();
    }
    const switchSeq = startRequest("space-switch");
    try {
      if (!sessionBindingId) {
        throw new Error("Space session identity is unavailable");
      }
      await persistActiveSpace(trimmed, sessionBindingId);
    } catch (error) {
      if (!isLatest("space-switch", switchSeq)) return;
      throw error;
    }
    if (!isLatest("space-switch", switchSeq)) return;
    if (!target) {
      await actions.ensureBootstrapped({
        force: true,
        silent: true,
        trackOpen: false,
      });
      if (!isLatest("space-switch", switchSeq)) return;
    }
    trackSpaceSwitch();
  },

  refreshIssues: async (
    params: IssueQueryParams,
    options: RefreshOptions = {},
  ) => {
    if (!ensureReady()) return;
    const normalizedParams = normalizeIssueQueryParams(params);
    const key = scopedKey(buildIssueQueryKey(normalizedParams));
    const current = state.issuesByKey[key] ?? EMPTY_ISSUE_LIST;
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs))
      return;
    const requestKey = `issues:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        issuesByKey: {
          ...state.issuesByKey,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const result = await spaceListIssues(normalizedParams, activeSpaceId());
        if (!isLatest(requestKey, requestSeq)) return;
        const user = state.session?.user ?? null;
        const items = user
          ? result.items.map((issue) => patchIssueAuthorSummaries(issue, user))
          : result.items;
        setState({
          issuesByKey: trimCacheRecord(
            {
              ...state.issuesByKey,
              [key]: {
                items,
                hasMore: result.hasMore,
                nextCursor: result.nextCursor,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_ISSUE_LIST_CACHES,
          ),
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        const latest = state.issuesByKey[key] ?? current;
        setState({
          issuesByKey: {
            ...state.issuesByKey,
            [key]: { ...latest, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  loadMoreIssues: async (params: IssueQueryParams) => {
    if (!ensureReady()) return;
    const normalizedParams = {
      ...normalizeIssueQueryParams(params),
      cursor: undefined,
    };
    const key = scopedKey(buildIssueQueryKey(normalizedParams));
    const current = state.issuesByKey[key] ?? EMPTY_ISSUE_LIST;
    const cursor = current.nextCursor?.trim();
    if (!current.hasMore || !cursor || current.isLoading) return;
    const requestKey = `issues-more:${key}:${cursor}`;
    return runRequest(requestKey, false, async () => {
      const requestSeq = startRequest(requestKey);
      const pending = state.issuesByKey[key];
      if (pending?.nextCursor === cursor && pending.error) {
        setState({
          issuesByKey: {
            ...state.issuesByKey,
            [key]: { ...pending, error: null },
          },
        });
      }
      try {
        const result = await spaceListIssues(
          { ...normalizedParams, cursor },
          activeSpaceId(),
        );
        if (!isLatest(requestKey, requestSeq)) return;
        const latest = state.issuesByKey[key];
        if (!latest || latest.nextCursor !== cursor) return;
        const user = state.session?.user ?? null;
        const incoming = user
          ? result.items.map((issue) => patchIssueAuthorSummaries(issue, user))
          : result.items;
        const mergedById = new Map(
          [...latest.items, ...incoming].map((issue) => [issue.id, issue]),
        );
        setState({
          issuesByKey: {
            ...state.issuesByKey,
            [key]: {
              ...latest,
              items: [...mergedById.values()].sort(compareUpdatedDesc),
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
              lastFetchedAt: Date.now(),
              error: null,
            },
          },
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        const latest = state.issuesByKey[key];
        if (latest?.nextCursor === cursor) {
          setState({
            issuesByKey: {
              ...state.issuesByKey,
              [key]: { ...latest, error: errMessage(error) },
            },
          });
        }
        throw error;
      }
    });
  },

  refreshGoals: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.goalsLastFetchedAt, options.maxAgeMs))
      return;
    return runRequest("goals", options.force, async () => {
      const requestSeq = startRequest("goals");
      try {
        const result = await spaceListGoals({}, activeSpaceId());
        if (!isLatest("goals", requestSeq)) return;
        setState({
          goals: result.items,
          goalsLastFetchedAt: Date.now(),
          bootError: null,
        });
      } catch (error) {
        if (!isLatest("goals", requestSeq)) return;
        setState({ bootError: errMessage(error) });
        throw error;
      }
    });
  },

  refreshIssueDetail: async (issueId: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !issueId) return;
    const key = detailKey(issueId);
    const current = state.issueDetails[key] ?? {
      detail: null,
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs))
      return;
    const requestKey = `issue:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        issueDetails: {
          ...state.issueDetails,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const startedAt = nowForSpaceMetric();
        const detail = await spaceGetIssue(issueId);
        if (!isLatest(requestKey, requestSeq)) return;
        const user = state.session?.user ?? null;
        const nextDetail = user
          ? patchIssueDetailAuthorSummaries(detail, user)
          : detail;
        recordSpaceMetric("space_issue_detail_open", {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: true,
        });
        setState({
          issueDetails: trimCacheRecord(
            {
              ...state.issueDetails,
              [key]: {
                detail: nextDetail,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_ISSUE_DETAIL_CACHES,
          ),
        });
        patchIssueInLists(nextDetail.issue, { preserveOrder: true });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        recordSpaceMetric("space_issue_detail_open", {
          ok: false,
          error: errMessage(error),
        });
        const latest = state.issueDetails[key] ?? current;
        setState({
          issueDetails: {
            ...state.issueDetails,
            [key]: { ...latest, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshSkills: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (!options.force && isFresh(state.skills.lastFetchedAt, options.maxAgeMs))
      return;
    return runRequest("skills", options.force, async () => {
      const requestSeq = startRequest("skills");
      setState({
        skills: {
          ...state.skills,
          isLoading: true,
          error: options.silent ? state.skills.error : null,
        },
      });
      try {
        const result = await spaceListSkills(activeSpaceId());
        if (!isLatest("skills", requestSeq)) return;
        const user = state.session?.user ?? null;
        const items = user
          ? result.items.map((skill) => patchSkillUploader(skill, user))
          : result.items;
        setState({
          skills: {
            items,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest("skills", requestSeq)) return;
        setState({
          skills: {
            ...state.skills,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
  },

  refreshSkillDetail: async (skillId: string, options: RefreshOptions = {}) => {
    if (!ensureReady() || !skillId) return;
    const key = detailKey(skillId);
    const current = state.skillDetails[key] ?? {
      detail: null,
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs))
      return;
    const requestKey = `skill:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        skillDetails: {
          ...state.skillDetails,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const detail = await spaceGetSkill(skillId);
        if (!isLatest(requestKey, requestSeq)) return;
        const user = state.session?.user ?? null;
        const nextDetail = user
          ? patchSkillDetailUploader(detail, user)
          : detail;
        setState({
          skillDetails: trimCacheRecord(
            {
              ...state.skillDetails,
              [key]: {
                detail: nextDetail,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_SKILL_DETAIL_CACHES,
          ),
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillDetails: {
            ...state.skillDetails,
            [key]: { ...current, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshSkillFile: async (
    skillId: string,
    path: string,
    options: RefreshOptions = {},
  ) => {
    if (!ensureReady() || !skillId || !path) return;
    const key = skillFileKey(skillId, path);
    const current = state.skillFiles[key] ?? {
      text: "",
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs))
      return;
    const requestKey = `skill-file:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        skillFiles: {
          ...state.skillFiles,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const result = await spaceGetSkillFile(skillId, path);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillFiles: trimCacheRecord(
            {
              ...state.skillFiles,
              [key]: {
                text: result.binary
                  ? `Binary file · ${result.mimeType ?? "unknown"} · ${formatBytesForStore(result.sizeBytes)}`
                  : (result.text ?? ""),
                binary: result.binary,
                mimeType: result.mimeType,
                sizeBytes: result.sizeBytes,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_SKILL_FILE_CACHES,
          ),
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillFiles: {
            ...state.skillFiles,
            [key]: { ...current, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshSkillRevisions: async (
    skillId: string,
    options: RefreshOptions = {},
  ) => {
    if (!ensureReady() || !skillId) return;
    const key = detailKey(skillId);
    const current = state.skillRevisions[key] ?? {
      history: null,
      lastFetchedAt: 0,
      isLoading: false,
      error: null,
    };
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs))
      return;
    const requestKey = `skill-revisions:${key}`;
    return runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        skillRevisions: {
          ...state.skillRevisions,
          [key]: {
            ...current,
            isLoading: true,
            error: options.silent ? current.error : null,
          },
        },
      });
      try {
        const history = await spaceListSkillRevisions(skillId);
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillRevisions: trimCacheRecord(
            {
              ...state.skillRevisions,
              [key]: {
                history,
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: null,
              },
            },
            SPACE_MAX_SKILL_DETAIL_CACHES,
          ),
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        setState({
          skillRevisions: {
            ...state.skillRevisions,
            [key]: { ...current, isLoading: false, error: errMessage(error) },
          },
        });
        throw error;
      }
    });
  },

  refreshLocalAgents: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (
      !options.force &&
      isFresh(state.localAgents.lastFetchedAt, options.maxAgeMs)
    )
      return;
    return runRequest("agents", options.force, async () => {
      const requestSeq = startRequest("agents");
      setState({
        localAgents: {
          ...state.localAgents,
          isLoading: true,
          error: options.silent ? state.localAgents.error : null,
        },
      });
      try {
        const items = await spaceListLocalAgents();
        if (!isLatest("agents", requestSeq)) return;
        setState({
          localAgents: {
            items,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest("agents", requestSeq)) return;
        setState({
          localAgents: {
            ...state.localAgents,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
  },

  refreshRegisteredAgents: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (
      !options.force &&
      isFresh(state.registeredAgents.lastFetchedAt, options.maxAgeMs)
    )
      return;
    return runRequest("registered-agents", options.force, async () => {
      const requestSeq = startRequest("registered-agents");
      setState({
        registeredAgents: {
          ...state.registeredAgents,
          isLoading: true,
          error: options.silent ? state.registeredAgents.error : null,
        },
      });
      try {
        const result = await spaceListRegisteredAgents(activeSpaceId());
        if (!isLatest("registered-agents", requestSeq)) return;
        setState({
          registeredAgents: {
            items: options.silent
              ? mergeRegisteredAgentsPreservingOrder(
                  state.registeredAgents.items,
                  result.items,
                )
              : [...result.items].sort(compareRegisteredAgentAvailability),
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest("registered-agents", requestSeq)) return;
        setState({
          registeredAgents: {
            ...state.registeredAgents,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
  },

  loadAvatarPresets: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return;
    if (
      !options.force &&
      isFresh(state.avatarPresets.lastFetchedAt, options.maxAgeMs)
    )
      return;
    return runRequest("avatar-presets", options.force, async () => {
      const requestSeq = startRequest("avatar-presets");
      setState({
        avatarPresets: {
          ...state.avatarPresets,
          isLoading: true,
          error: options.silent ? state.avatarPresets.error : null,
        },
      });
      try {
        const presets = await spaceGetAvatarPresets();
        if (!isLatest("avatar-presets", requestSeq)) return;
        setState({
          avatarPresets: {
            people: presets.people,
            agents: presets.agents,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest("avatar-presets", requestSeq)) return;
        setState({
          avatarPresets: {
            ...state.avatarPresets,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
  },

  syncEvents: async (options: RefreshOptions = {}) => {
    if (!ensureReady()) return [];
    const current = state.events;
    if (!options.force && isFresh(current.lastFetchedAt, options.maxAgeMs))
      return [];
    const requestKey = "events";
    let delivered: SpaceEvent[] = [];
    await runRequest(requestKey, options.force, async () => {
      const requestSeq = startRequest(requestKey);
      setState({
        events: {
          ...state.events,
          isLoading: true,
          error: options.silent ? state.events.error : null,
        },
      });
      try {
        const baseline = !state.events.initialized;
        const startedAt = nowForSpaceMetric();
        recordSpaceMetric("space_event_sync_start");
        const result = await spaceListEvents(
          {
            cursor: state.events.cursor,
            limit: 100,
            tail: baseline && !state.events.cursor,
          },
          activeSpaceId(),
        );
        if (!isLatest(requestKey, requestSeq)) return;
        const seenIds = new Set(state.events.items.map((event) => event.id));
        const newItems = result.items.filter((event) => {
          if (seenIds.has(event.id)) return false;
          seenIds.add(event.id);
          return true;
        });
        const nextCursor = result.nextCursor ?? state.events.cursor ?? null;
        delivered = baseline ? [] : newItems;
        recordSpaceMetric("space_event_sync_end", {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          count: newItems.length,
          ok: true,
        });
        setState({
          events: {
            items: [...state.events.items, ...newItems].slice(-200),
            cursor: nextCursor,
            initialized: true,
            lastFetchedAt: Date.now(),
            isLoading: false,
            error: null,
          },
        });
      } catch (error) {
        if (!isLatest(requestKey, requestSeq)) return;
        recordSpaceMetric("space_event_sync_end", {
          ok: false,
          error: errMessage(error),
        });
        setState({
          events: {
            ...state.events,
            isLoading: false,
            error: errMessage(error),
          },
        });
        throw error;
      }
    });
    return delivered;
  },

  createIssue: (input) =>
    withSpaceMutationMetric("issue.create", async () => {
      const result = await spaceCreateIssue(input, activeSpaceId());
      const user = state.session?.user ?? null;
      const issue = user
        ? patchIssueAuthorSummaries(result.issue, user)
        : result.issue;
      prependIssueToLists(issue);
      return issue;
    }),

  updateIssue: (input) =>
    withSpaceMutationMetric("issue.update", async () => {
      const result = await spaceUpdateIssue(input);
      const user = state.session?.user ?? null;
      const issue = user
        ? patchIssueAuthorSummaries(result.issue, user)
        : result.issue;
      patchIssueInLists(issue);
      return issue;
    }),

  loadOlderIssueComments: (issueId) =>
    withSpaceMutationMetric("issue.comments.older", async () => {
      const current = state.issueDetails[detailKey(issueId)]?.detail;
      if (!current?.comments.hasMore || !current.comments.nextCursor) return;
      const page = await spaceListIssueComments(issueId, {
        cursor: current.comments.nextCursor,
        limit: 20,
      });
      patchIssueDetail(issueId, (detail) => {
        const existingIds = new Set(
          detail.comments.items.map((item) => item.id),
        );
        const older = page.items.filter((item) => !existingIds.has(item.id));
        return {
          ...detail,
          comments: {
            ...detail.comments,
            ...page,
            items: [...older, ...detail.comments.items],
          },
        };
      });
    }),

  setIssueAssignee: (issueId, assignee) =>
    withSpaceMutationMetric("issue.assignee.set", async () => {
      const requestKey = `issue:${detailKey(issueId)}`;
      const requestSeq = startRequest(requestKey);
      const result = await spaceSetIssueAssignee(issueId, assignee);
      if (isLatest(requestKey, requestSeq)) {
        patchIssueInLists(result.issue, { preserveOrder: true });
      }
      return result.issue;
    }),

  cancelIssueAssignee: (issueId) =>
    withSpaceMutationMetric("issue.assignee.cancel", async () => {
      const requestKey = `issue:${detailKey(issueId)}`;
      const requestSeq = startRequest(requestKey);
      const result = await spaceCancelIssueAssignee(issueId);
      if (isLatest(requestKey, requestSeq)) {
        patchIssueInLists(result.issue, { preserveOrder: true });
      }
      return result.issue;
    }),

  createGoal: (input) =>
    withSpaceMutationMetric("goal.create", async () => {
      const result = await spaceCreateGoal(input, activeSpaceId());
      await actions.refreshGoals({ force: true, silent: true });
      return result.goal;
    }),

  updateGoal: (input) =>
    withSpaceMutationMetric("goal.update", async () => {
      const result = await spaceUpdateGoal(input);
      await actions.refreshGoals({ force: true, silent: true });
      return result.goal;
    }),

  archiveGoal: (goalId) =>
    withSpaceMutationMetric("goal.archive", async () => {
      await spaceArchiveGoal(goalId);
      await actions.refreshGoals({ force: true, silent: true });
      setState({
        issuesByKey: {},
        issueDetails: {},
      });
    }),

  uploadIssueAttachments: (issueId, filePaths) =>
    withSpaceMutationMetric("issue.attachments.upload", async () => {
      const result = await spaceUploadIssueAttachments({ issueId, filePaths });
      const attachmentUpdatedAt = result.attachments.reduce<string | null>(
        (latest, attachment) => {
          if (!latest) return attachment.createdAt;
          return Date.parse(attachment.createdAt) > Date.parse(latest)
            ? attachment.createdAt
            : latest;
        },
        null,
      );
      patchIssueDetail(issueId, (detail) => ({
        ...detail,
        attachments: [...detail.attachments, ...result.attachments],
        issue: {
          ...detail.issue,
          attachmentCount:
            (detail.issue.attachmentCount ?? detail.attachments.length) +
            result.attachments.length,
          updatedAt: attachmentUpdatedAt ?? detail.issue.updatedAt,
        },
      }));
      const currentIssue =
        state.issueDetails[detailKey(issueId)]?.detail?.issue;
      if (currentIssue) patchIssueInLists(currentIssue);
      return result.attachments;
    }),

  downloadIssueAttachment: (input) => spaceDownloadIssueAttachment(input),

  commentIssue: (issueId, body, filePaths = []) =>
    withSpaceMutationMetric("issue.comment", async () => {
      const result = await spaceCommentIssue(issueId, body, filePaths);
      const user = state.session?.user ?? null;
      const comment = user
        ? {
            ...result.comment,
            author: patchUserSummary(result.comment.author, user),
          }
        : result.comment;
      patchIssueDetail(issueId, (detail) => ({
        ...detail,
        comments: {
          ...detail.comments,
          items: [...detail.comments.items, comment],
        },
        issue: {
          ...detail.issue,
          updatedAt: comment.createdAt,
          commentCount:
            (detail.issue.commentCount ?? detail.comments.items.length) + 1,
          attachmentCount:
            (detail.issue.attachmentCount ?? 0) +
            (comment.attachments?.length ?? 0),
        },
      }));
      const currentIssue =
        state.issueDetails[detailKey(issueId)]?.detail?.issue;
      if (currentIssue)
        patchIssueInLists(currentIssue, {
          establishesCurrentAccountRelation: true,
        });
    }),

  setIssueState: (issueId, nextState) =>
    withSpaceMutationMetric("issue.state", async () => {
      const result = await spaceSetIssueState(issueId, nextState);
      const current =
        state.issueDetails[detailKey(issueId)]?.detail?.issue ??
        findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  closeOwnIssue: (issueId) =>
    withSpaceMutationMetric("issue.close_own", async () => {
      const result = await spaceCloseOwnIssue(issueId);
      const current =
        state.issueDetails[detailKey(issueId)]?.detail?.issue ??
        findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  closeIssue: (issueId) =>
    withSpaceMutationMetric("issue.close", async () => {
      const result = await spaceCloseIssue(issueId);
      const current =
        state.issueDetails[detailKey(issueId)]?.detail?.issue ??
        findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  completeIssue: (issueId) =>
    withSpaceMutationMetric("issue.complete", async () => {
      const result = await spaceCompleteIssue(issueId);
      const current =
        state.issueDetails[detailKey(issueId)]?.detail?.issue ??
        findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  cancelIssueClaim: (issueId) =>
    withSpaceMutationMetric("issue.cancel_claim", async () => {
      const result = await spaceCancelIssueClaim(issueId);
      const current =
        state.issueDetails[detailKey(issueId)]?.detail?.issue ??
        findIssueInLists(issueId);
      if (current)
        patchIssueInLists({
          ...current,
          state: result.state,
          updatedAt: result.updatedAt,
        });
    }),

  updateProfile: (input) =>
    withSpaceMutationMetric("profile.update", async () => {
      const session = await spaceUpdateProfile(input);
      patchProfileInCaches(session);
    }),

  uploadSkillZip: (input) =>
    withSpaceMutationMetric("skill.upload", async () => {
      const result = await spaceUploadSkillZip(input);
      setState({
        skills: {
          ...state.skills,
          items: [
            result.skill,
            ...state.skills.items.filter(
              (skill) => skill.id !== result.skill.id,
            ),
          ].sort(compareUpdatedDesc),
        },
      });
      return result.skill;
    }),

  uploadSkillRevision: (skillId, filePath, source) =>
    withSpaceMutationMetric("skill.revision.upload", async () => {
      const result = await spaceUploadSkillZip(
        source ? { filePath, skillId, source } : { filePath, skillId },
      );
      setState({
        skills: {
          ...state.skills,
          items: [
            result.skill,
            ...state.skills.items.filter(
              (skill) => skill.id !== result.skill.id,
            ),
          ].sort(compareUpdatedDesc),
        },
        skillDetails: Object.fromEntries(
          Object.entries(state.skillDetails).filter(
            ([key]) => unscopedKey(key) !== result.skill.id,
          ),
        ),
        skillFiles: Object.fromEntries(
          Object.entries(state.skillFiles).filter(
            ([key]) => !unscopedKey(key).startsWith(`${result.skill.id}\n`),
          ),
        ),
        skillRevisions: Object.fromEntries(
          Object.entries(state.skillRevisions).filter(
            ([key]) => unscopedKey(key) !== result.skill.id,
          ),
        ),
      });
      return result.skill;
    }),

  rollbackSkill: (skillId, revision) =>
    withSpaceMutationMetric("skill.revision.rollback", async () => {
      const result = await spaceRollbackSkill(skillId, revision);
      setState({
        skills: {
          ...state.skills,
          items: [
            result.skill,
            ...state.skills.items.filter(
              (skill) => skill.id !== result.skill.id,
            ),
          ].sort(compareUpdatedDesc),
        },
        skillDetails: Object.fromEntries(
          Object.entries(state.skillDetails).filter(
            ([key]) => unscopedKey(key) !== result.skill.id,
          ),
        ),
        skillFiles: Object.fromEntries(
          Object.entries(state.skillFiles).filter(
            ([key]) => !unscopedKey(key).startsWith(`${result.skill.id}\n`),
          ),
        ),
        skillRevisions: Object.fromEntries(
          Object.entries(state.skillRevisions).filter(
            ([key]) => unscopedKey(key) !== result.skill.id,
          ),
        ),
      });
      return result.skill;
    }),

  deleteSkill: (skillId) =>
    withSpaceMutationMetric("skill.delete", async () => {
      await spaceDeleteSkill(skillId);
      setState({
        skills: {
          ...state.skills,
          items: state.skills.items.filter((skill) => skill.id !== skillId),
        },
        skillDetails: Object.fromEntries(
          Object.entries(state.skillDetails).filter(
            ([key]) => unscopedKey(key) !== skillId,
          ),
        ),
        skillFiles: Object.fromEntries(
          Object.entries(state.skillFiles).filter(
            ([key]) => !unscopedKey(key).startsWith(`${skillId}\n`),
          ),
        ),
        skillRevisions: Object.fromEntries(
          Object.entries(state.skillRevisions).filter(
            ([key]) => unscopedKey(key) !== skillId,
          ),
        ),
      });
    }),

  installSkill: (input) =>
    withSpaceMutationMetric("skill.install", () => spaceInstallSkill(input)),

  registerAgent: (input) =>
    withSpaceMutationMetric("agent.register", async () => {
      const agent = await spaceRegisterAgent(input);
      const registeredAgent = localAgentToRegisteredAgent(agent);
      invalidateRegisteredAgentReads();
      setState({
        localAgents: {
          ...state.localAgents,
          items: [
            agent,
            ...state.localAgents.items.filter((item) => item.id !== agent.id),
          ],
        },
        registeredAgents: {
          ...state.registeredAgents,
          isLoading: false,
          error: null,
          items: [
            registeredAgent,
            ...state.registeredAgents.items.filter(
              (item) => item.id !== registeredAgent.id,
            ),
          ],
        },
      });
      return agent;
    }),

  updateRegisteredAgent: (input) =>
    withSpaceMutationMetric("agent.update", async () => {
      const agent = await spaceUpdateRegisteredAgent(input);
      const registeredAgent = localAgentToRegisteredAgent(agent);
      invalidateRegisteredAgentReads();
      setState({
        localAgents: {
          ...state.localAgents,
          items: state.localAgents.items.map((item) =>
            item.id === agent.id ? agent : item,
          ),
        },
        registeredAgents: {
          ...state.registeredAgents,
          isLoading: false,
          error: null,
          items: state.registeredAgents.items.map((item) =>
            item.id === registeredAgent.id
              ? {
                  ...item,
                  ...registeredAgent,
                  // PATCH does not mutate or project the Subscription
                  // collection.  In particular, a remote Agent has no local
                  // row from which the Rust bridge could reconstruct it.
                  subscriptions: item.subscriptions ?? [],
                }
              : item,
          ),
        },
        issuesByKey: Object.fromEntries(
          Object.entries(state.issuesByKey).map(([key, list]) => [
            key,
            {
              ...list,
              items: list.items.map((issue) =>
                patchIssueRegisteredAgentAuthor(issue, agent),
              ),
            },
          ]),
        ),
        issueDetails: Object.fromEntries(
          Object.entries(state.issueDetails).map(([key, detailState]) => [
            key,
            detailState.detail
              ? {
                  ...detailState,
                  detail: patchIssueDetailRegisteredAgentAuthor(
                    detailState.detail,
                    agent,
                  ),
                }
              : detailState,
          ]),
        ),
      });
      return agent;
    }),

  createRegisteredAgentSubscription: (input) =>
    withSpaceMutationMetric("agent.subscription.create", async () => {
      const result = await spaceCreateRegisteredAgentSubscription({
        spaceId: activeSpaceId(),
        registeredAgentId: input.registeredAgentId,
        goalId: input.goalId,
        stateFilter: input.stateFilter,
      });
      const subscription = result.subscription;
      invalidateRegisteredAgentReads();
      setState({
        localAgents: {
          ...state.localAgents,
          items: state.localAgents.items.map((agent) =>
            agent.id === input.registeredAgentId
              ? {
                  ...agent,
                  subscriptions: [
                    ...agent.subscriptions.filter(
                      (item) => item.id !== subscription.id,
                    ),
                    subscription,
                  ],
                }
              : agent,
          ),
        },
        registeredAgents: {
          ...state.registeredAgents,
          items: state.registeredAgents.items.map((agent) =>
            agent.id === input.registeredAgentId
              ? {
                  ...agent,
                  subscriptions: [
                    ...(agent.subscriptions ?? []).filter(
                      (item) => item.id !== subscription.id,
                    ),
                    subscription,
                  ],
                }
              : agent,
          ),
        },
      });
      return subscription;
    }),

  deleteRegisteredAgentSubscription: (subscriptionId) =>
    withSpaceMutationMetric("agent.subscription.delete", async () => {
      await spaceDeleteRegisteredAgentSubscription(subscriptionId);
      invalidateRegisteredAgentReads();
      setState({
        localAgents: {
          ...state.localAgents,
          items: state.localAgents.items.map((agent) => ({
            ...agent,
            subscriptions: agent.subscriptions.filter(
              (item) => item.id !== subscriptionId,
            ),
          })),
        },
        registeredAgents: {
          ...state.registeredAgents,
          items: state.registeredAgents.items.map((agent) => ({
            ...agent,
            subscriptions: (agent.subscriptions ?? []).filter(
              (item) => item.id !== subscriptionId,
            ),
          })),
        },
      });
    }),

  reevaluateRegisteredAgent: (id) =>
    withSpaceMutationMetric("agent.scope.reevaluate", async () => {
      const result = await spaceReevaluateRegisteredAgent(id);
      return result.subscriptionCount;
    }),

  updateRegisteredAgentAvatar: (input) =>
    withSpaceMutationMetric("agent.avatar.update", async () => {
      const agent = await spaceUpdateRegisteredAgentAvatar(input);
      const registeredAgent = localAgentToRegisteredAgent(agent);
      invalidateRegisteredAgentReads();
      setState({
        localAgents: {
          ...state.localAgents,
          items: state.localAgents.items.map((item) =>
            item.id === agent.id ? agent : item,
          ),
        },
        registeredAgents: {
          ...state.registeredAgents,
          isLoading: false,
          error: null,
          items: state.registeredAgents.items.map((item) =>
            item.id === registeredAgent.id
              ? { ...item, ...registeredAgent }
              : item,
          ),
        },
        issuesByKey: Object.fromEntries(
          Object.entries(state.issuesByKey).map(([key, list]) => [
            key,
            {
              ...list,
              items: list.items.map((issue) =>
                patchIssueRegisteredAgentAuthor(issue, agent),
              ),
            },
          ]),
        ),
        issueDetails: Object.fromEntries(
          Object.entries(state.issueDetails).map(([key, detailState]) => [
            key,
            detailState.detail
              ? {
                  ...detailState,
                  detail: patchIssueDetailRegisteredAgentAuthor(
                    detailState.detail,
                    agent,
                  ),
                }
              : detailState,
          ]),
        ),
      });
      return agent;
    }),

  revokeRegisteredAgent: (id) =>
    withSpaceMutationMetric("agent.revoke", async () => {
      const agent = await spaceRevokeRegisteredAgent(id);
      const registeredAgent = localAgentToRegisteredAgent(agent);
      invalidateRegisteredAgentReads();
      setState({
        localAgents: {
          ...state.localAgents,
          items: state.localAgents.items.map((item) =>
            item.id === agent.id ? agent : item,
          ),
        },
        registeredAgents: {
          ...state.registeredAgents,
          isLoading: false,
          error: null,
          items: state.registeredAgents.items.map((item) =>
            item.id === registeredAgent.id
              ? { ...item, ...registeredAgent }
              : item,
          ),
        },
      });
      return agent;
    }),

  logout: async () => {
    invalidatePendingRequests();
    activeSpacePersistenceBinding = null;
    activeSpacePersistenceQueue = Promise.resolve();
    setState({ ...initialState(), boot: "signedOut" });
    await spaceLogout();
  },
};

function findIssueInLists(issueId: string): SpaceIssue | null {
  for (const list of Object.values(state.issuesByKey)) {
    const found = list.items.find((issue) => issue.id === issueId);
    if (found) return found;
  }
  return null;
}

function formatBytesForStore(value?: number | null): string {
  if (!value || value <= 0) return "0 KB";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

snapshot = buildSnapshot();

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (state.boot === "idle") {
    void actions.ensureBootstrapped();
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): SpaceDataSnapshot {
  return snapshot;
}

export function getSkillFileState(
  skillId: string,
  path: string,
): SpaceSkillFileState | null {
  return state.skillFiles[skillFileKey(skillId, path)] ?? null;
}

export function getSkillRevisionState(
  skillId: string,
): SpaceSkillRevisionState | null {
  return state.skillRevisions[detailKey(skillId)] ?? null;
}

export function __resetSpaceStoreForTest(): void {
  state = initialState();
  listeners.clear();
  bootPromise = null;
  activeSpacePersistenceQueue = Promise.resolve();
  activeSpacePersistenceBinding = null;
  seq = 0;
  latestSeqByKey.clear();
  inFlightRequests.clear();
  snapshot = buildSnapshot();
}

export function __setSpaceStoreStateForTest(patch: Partial<StoreState>): void {
  setState(patch);
}
