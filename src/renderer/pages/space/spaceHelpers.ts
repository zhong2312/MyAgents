import type {
  LocalRegisteredAgent,
  SpaceEvent,
  SpaceIssue,
  SpaceIssueClaim,
  SpaceSession,
} from "@/api/spaceCloud";
import type { Project } from "@/config/types";
import { findProjectForAgent } from "@/api/spaceCloud";

export const ISSUE_STATUSES = [
  "open",
  "todo",
  "doing",
  "done",
  "closed",
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];
// Cloud intentionally treats a missing state as the active-state default.
// Product-level “All” must stay explicit across the query boundary.
export const ALL_ISSUE_STATE_FILTER = "all";
export const ACTIVE_ISSUE_STATE_FILTER = "open,todo,doing";
const CLOSED_ISSUE_STATUSES = new Set(["done", "closed"]);
const ISSUE_STATUS_LABEL_FALLBACKS: Record<IssueStatus, string> = {
  open: "open",
  todo: "todo",
  doing: "doing",
  done: "done",
  closed: "closed",
};

type IssueStatusTranslator = (
  key: string,
  options?: { defaultValue?: string },
) => string;

export interface IssueQueryParams {
  q?: string;
  state?: string;
  goalId?: string;
  includeSubtree?: boolean;
  humanOnly?: boolean | null;
  related?: "me";
  cursor?: string;
  limit?: number;
}

export function buildIssueQueryKey(params: IssueQueryParams): string {
  const normalized = {
    q: params.q?.trim() ?? "",
    state: params.state?.trim() ?? "",
    goalId: params.goalId?.trim() ?? "",
    includeSubtree: params.includeSubtree ? "true" : "",
    humanOnly:
      params.humanOnly === undefined || params.humanOnly === null
        ? ""
        : String(params.humanOnly),
    related: params.related ?? "",
    cursor: params.cursor?.trim() ?? "",
    limit: params.limit ?? 50,
  };
  return new URLSearchParams([
    ["q", normalized.q],
    ["state", normalized.state],
    ["goalId", normalized.goalId],
    ["includeSubtree", normalized.includeSubtree],
    ["humanOnly", normalized.humanOnly],
    ["related", normalized.related],
    ["cursor", normalized.cursor],
    ["limit", String(normalized.limit)],
  ]).toString();
}

export type AgentAvailability =
  | "online"
  | "offline"
  | "disabled"
  | "connecting";

export function registeredAgentAvailability(
  agent: Pick<LocalRegisteredAgent, "status" | "presence" | "connecting">,
): AgentAvailability {
  if (agent.status.trim().toLowerCase() !== "active") return "disabled";
  if (agent.connecting) return "connecting";
  return agent.presence === "online" ? "online" : "offline";
}

export function compareRegisteredAgentAvailability(
  left: Pick<
    LocalRegisteredAgent,
    "id" | "status" | "presence" | "lastOnlineAt"
  >,
  right: Pick<
    LocalRegisteredAgent,
    "id" | "status" | "presence" | "lastOnlineAt"
  >,
): number {
  const rank = (agent: typeof left) => {
    if (agent.status.trim().toLowerCase() !== "active") return 2;
    return agent.presence === "online" ? 0 : 1;
  };
  const rankDelta = rank(left) - rank(right);
  if (rankDelta !== 0) return rankDelta;
  const timeDelta =
    Date.parse(right.lastOnlineAt ?? "") - Date.parse(left.lastOnlineAt ?? "");
  if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
  if (left.lastOnlineAt && !right.lastOnlineAt) return -1;
  if (!left.lastOnlineAt && right.lastOnlineAt) return 1;
  return left.id.localeCompare(right.id);
}

export function spaceEventsRequireSessionRefresh(
  events: Array<Pick<SpaceEvent, "type" | "resourceType">>,
): boolean {
  return events.some(
    (event) =>
      event.type === "space.plan_changed" ||
      event.resourceType === "space" ||
      event.type.startsWith("space."),
  );
}

export function spaceEventsRequireIssueListRefresh(
  events: Array<Pick<SpaceEvent, "type" | "resourceType">>,
): boolean {
  return events.some((event) => {
    const resourceType = event.resourceType ?? "";
    return (
      resourceType === "issue" ||
      resourceType === "comment" ||
      resourceType === "goal" ||
      resourceType === "delivery" ||
      event.type.startsWith("issue.") ||
      event.type.startsWith("comment.") ||
      event.type.startsWith("goal.") ||
      event.type.startsWith("delivery.")
    );
  });
}

export function findJoinedSpaceBySlug(
  session: SpaceSession | null | undefined,
  slug: string,
): SpaceSession["space"] | null {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!session || !normalizedSlug) return null;

  return (
    [session.space, ...(session.spaces ?? [])].find(
      (space) => space.slug.trim().toLowerCase() === normalizedSlug,
    ) ?? null
  );
}

export function isSpaceAdmin(session: SpaceSession | null): boolean {
  return (
    session?.membership?.role === "owner" ||
    session?.membership?.role === "admin"
  );
}

export function isClosedIssue(status: string): boolean {
  return CLOSED_ISSUE_STATUSES.has(status);
}

export function isRegisteredAgentVisibleInList(
  agent: Pick<LocalRegisteredAgent, "status">,
): boolean {
  return agent.status.trim().toLowerCase() !== "revoked";
}

function normalizeIssueNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function issueDisplayNumber(
  issue: Pick<SpaceIssue, "id"> &
    Partial<Pick<SpaceIssue, "number" | "issueNumber">>,
): string | null {
  const number =
    normalizeIssueNumber(issue.number) ??
    normalizeIssueNumber(issue.issueNumber);
  return number ? `#${number}` : null;
}

export function canCloseOwnIssue(
  session: SpaceSession | null,
  issue: SpaceIssue | null,
): boolean {
  if (!session || !issue || isSpaceAdmin(session) || isClosedIssue(issue.state))
    return false;
  return (
    issue.createdByUserId === session.user.id ||
    issue.creator?.id === session.user.id ||
    issue.author?.id === session.user.id
  );
}

function normalizedIdentityValue(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function localAgentMatchesCurrentSpaceIdentity(
  localAgent: LocalRegisteredAgent | undefined,
  currentSpaceId: string | null | undefined,
  currentUserId: string | null | undefined,
  currentLocalDeviceId: string | null | undefined,
): boolean {
  if (
    !localAgent ||
    !currentSpaceId ||
    !currentUserId ||
    !currentLocalDeviceId
  ) {
    return false;
  }
  const spaceId = normalizedIdentityValue(localAgent.spaceId);
  const targetSpaceId = normalizedIdentityValue(currentSpaceId);
  const ownerUserId = normalizedIdentityValue(localAgent.ownerUserId);
  const targetUserId = normalizedIdentityValue(currentUserId);
  const deviceId = normalizedIdentityValue(
    localAgent.deviceId ?? localAgent.device?.deviceId,
  );
  const targetDeviceId = normalizedIdentityValue(currentLocalDeviceId);
  return (
    spaceId === targetSpaceId &&
    ownerUserId === targetUserId &&
    deviceId === targetDeviceId
  );
}

export function getIssueStatusOptions(args: {
  session: SpaceSession | null;
  issue: SpaceIssue | null;
  t?: IssueStatusTranslator;
}): Array<{ value: string; label: string; kind: "set-status" | "close-own" }> {
  if (!args.session || !args.issue) return [];
  if (isSpaceAdmin(args.session)) {
    return ISSUE_STATUSES.map((state) => ({
      value: state,
      label: issueStatusLabel(state, args.t),
      kind: "set-status",
    }));
  }
  if (canCloseOwnIssue(args.session, args.issue)) {
    return [
      {
        value: "closed",
        label:
          args.t?.("space.issueActions.closeIssue", {
            defaultValue: "Close issue",
          }) ?? "Close issue",
        kind: "close-own",
      },
    ];
  }
  return [];
}

export function issueStatusLabel(
  status: string,
  t?: IssueStatusTranslator,
): string {
  const normalized = normalizeIssueStatusToken(status);
  const knownStatus = ISSUE_STATUSES.find((item) => item === normalized);
  const fallback = knownStatus
    ? ISSUE_STATUS_LABEL_FALLBACKS[knownStatus]
    : status.replaceAll("_", " ");
  if (!knownStatus || !t) return fallback;
  return t(`space.issueStatuses.${knownStatus}`, { defaultValue: fallback });
}

function normalizeIssueStatusToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

export function issueDisplayTitle(
  issue: Pick<SpaceIssue, "state" | "title">,
): string {
  return issue.title.replace(/^\[([^\]]+)\]\s*/, (match, rawStatus: string) =>
    normalizeIssueStatusToken(rawStatus) ===
    normalizeIssueStatusToken(issue.state)
      ? ""
      : match,
  );
}

export function claimHandlerLabel(
  claim: SpaceIssueClaim | null | undefined,
): string | null {
  if (!claim) return null;
  return (
    claim.actorName ||
    claim.actor?.name ||
    claim.actor?.id ||
    claim.actorId ||
    null
  );
}

export function claimHandlerTypeKey(
  claim: SpaceIssueClaim | null | undefined,
): string | null {
  if (!claim) return null;
  if (claim.actorType === "registered_agent")
    return "space.detail.claimHandlerTypeRegisteredAgent";
  if (claim.actorType === "user") return "space.detail.claimHandlerTypeUser";
  return null;
}

export function buildIssueCommandPrompt(args: {
  spaceName: string;
  spaceSlug: string;
  issueId: string;
}): string {
  return [
    `Instruction: 这是一个来自 MyAgents Space「${args.spaceName}」的 Issue。请先通过下方只读命令获取当前上下文（标题、正文、附件元数据和最新评论）；如附件与判断有关，按需下载并读取。读取后，先向用户概括你的理解并提出下一步建议，等待用户确认后再修改代码、执行处理动作或变更 Issue 状态。`,
    "",
    `- Issue ID: ${args.issueId}`,
    `- Space slug: ${args.spaceSlug}`,
    "",
    "阅读 Issue：",
    `\`myagents space issue view ${args.issueId} --space ${args.spaceSlug} --comments --json\``,
    "",
    "查看其他可用操作：",
    "`myagents space issue --help`",
  ].join("\n");
}

export function formatAgentSecondaryLabel(
  agent: LocalRegisteredAgent,
  projects: Project[],
): string {
  const project = findProjectForAgent(projects, agent);
  return (
    project?.displayName ||
    project?.name ||
    agent.workspaceLabel ||
    agent.workspacePath
  );
}
