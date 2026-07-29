import type { Project } from "@/config/types";
import { i18n } from "@/i18n";
import { workspacePathsEqual } from "@/../shared/workspacePath";

export const DEFAULT_SPACE_ID = "official";

export type SpaceAvatarUrls = Record<"64" | "128" | "256", string>;

export interface SpaceAvatarPreset {
  id: string;
  kind: "people" | "agents";
  version: string;
  url: string;
  urls: SpaceAvatarUrls;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`MyAgents Space requires Tauri runtime: ${cmd}`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function spacePath(spaceId = DEFAULT_SPACE_ID): string {
  return encodeURIComponent(spaceId || DEFAULT_SPACE_ID);
}

export interface SpaceUser {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  avatarPresetId?: string | null;
  avatarUrls?: SpaceAvatarUrls | null;
}

export interface SpaceUserSummary {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  avatarPresetId?: string | null;
  avatarUrls?: SpaceAvatarUrls | null;
}

export interface SpaceIdentitySummary extends SpaceUserSummary {
  type?: "user" | "registered_agent" | "system";
  owner?: SpaceUserSummary | null;
}

export interface SpaceInfo {
  id: string;
  slug: string;
  name: string;
  joinPolicy: string;
  rootGoalId?: string | null;
  createdByUserId?: string | null;
  billingOwnerUserId?: string | null;
  planTier?: string | null;
  effectivePlanTier?: "free" | "pro" | string | null;
  planExpiresAt?: string | null;
  entitlement?: SpaceEntitlement | null;
  limits?: SpacePlanLimits;
  usage?: SpaceUsage | null;
  quotaBypassed?: boolean;
  spaceKind?: "official" | "user" | string | null;
  avatarUrl?: string | null;
  avatarSizeBytes?: number | null;
}

export interface SpaceMembership {
  id: string;
  spaceId?: string;
  userId?: string;
  role: "owner" | "admin" | "member";
  createdAt?: string;
}

export interface SpacePlanLimits {
  ownedSpacesMax: number;
  joinedMembersMax: number | null;
  openIssuesMax: number | null;
  hostedSkillsMax: number | null;
  registeredAgentsMax: number | null;
  storageBytesMax: number | null;
}

export interface SpaceEntitlement {
  source: "account_plan" | "space_override" | "fallback" | string;
  key: string;
  displayName: string;
  expiresAt: string | null;
  version: number | null;
}

export interface SpaceUsage {
  memberSeats: number;
  openIssues: number;
  hostedSkills: number;
  registeredAgents: number;
  storageBytes: number;
}

export interface SpaceAccountPlanMembership {
  planTier: "pro";
  status: "active" | "expired" | "revoked";
  startsAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  source: string;
  version: number;
}

export interface SpaceAccountPlan {
  effectiveTier: "free" | "pro";
  evaluatedAt: string;
  membership: SpaceAccountPlanMembership | null;
}

export interface SpaceListItem extends SpaceInfo {
  membership: SpaceMembership;
  canManage?: boolean;
  pendingJoinRequestCount?: number;
  limits?: SpacePlanLimits;
  usage?: SpaceUsage | null;
}

export interface SpaceSession {
  sessionBindingId?: string;
  baseUrl: string;
  expiresAt?: string | null;
  user: SpaceUser;
  accountPlan?: SpaceAccountPlan | null;
  space: SpaceInfo;
  membership: SpaceMembership;
  spaces?: SpaceListItem[];
  lastActiveSpaceId?: string | null;
  updatedAt: string;
}

export interface SpaceMember {
  id: string;
  spaceId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  createdAt: string;
  user: SpaceUser;
}

export interface SpaceJoinRequest {
  id: string;
  spaceId: string;
  userId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  user: SpaceUser;
}

export interface SpaceInvitation {
  id: string;
  email: string;
  role: "admin" | "member" | string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceMembersPayload {
  members: SpaceMember[];
  items?: SpaceMember[];
  joinRequests: SpaceJoinRequest[];
  invitations: SpaceInvitation[];
  usage: SpaceUsage;
  limits: SpacePlanLimits;
}

export interface SpaceBuildCapability {
  available: boolean;
  baseUrl?: string | null;
  publicClientId?: string | null;
  reason?: string | null;
  environments?: Array<"production" | "dev">;
  activeEnvironment?: "production" | "dev";
}

export interface SpaceTag {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
}

export type SpaceIssueState = "open" | "todo" | "doing" | "done" | "closed";

export interface SpaceGoal {
  id: string;
  spaceId: string;
  parentGoalId?: string | null;
  path: string;
  depth: number;
  title: string;
  context: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  goalPathLabel?: string | null;
}

export interface SpaceGoalSubscription {
  id: string;
  spaceId: string;
  actorType: "user" | "registered_agent";
  actorId: string;
  goalId: string;
  includeSubtree: boolean;
  stateFilter: string[];
  goalPathLabel?: string | null;
  createdAt: string;
}

export interface SpaceIssue {
  id: string;
  number?: number | null;
  issueNumber?: number | null;
  spaceId: string;
  goalId?: string | null;
  parentIssueId?: string | null;
  title: string;
  body: string;
  state: SpaceIssueState | string;
  humanOnly?: boolean;
  createdByType?: "user" | "registered_agent";
  createdById?: string;
  createdByUserId?: string;
  creator?: SpaceIdentitySummary;
  assignee?: SpaceIdentitySummary | null;
  assignedAt?: string | null;
  notificationVersion?: number;
  goalPathLabel?: string | null;
  status?: string;
  author?: SpaceIdentitySummary;
  tags?: SpaceTag[];
  commentCount?: number;
  attachmentCount?: number;
  claim?: SpaceIssueClaim | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceIssueComment {
  id: string;
  author: SpaceIdentitySummary & { type: "user" | "registered_agent" | "system" };
  body: string;
  attachments: SpaceAttachment[];
  createdAt: string;
}

export interface SpaceAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType?: string | null;
  createdAt: string;
}

export interface SpaceAttachmentDraft {
  path: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
}

export interface SpaceDownloadAttachmentResult {
  name: string;
  relativePath: string;
  fullPath: string;
  sizeBytes: number;
}

export interface SpaceIssueGoalReference {
  goalId: string;
  goalPath: string;
  goalPathLabel?: string | null;
  goalTitle: string;
  goalContext: string;
}

export interface SpaceIssueClaim {
  id: string;
  spaceId: string;
  issueId: string;
  actorType: "user" | "registered_agent";
  actorId: string;
  actorName?: string | null;
  actor?: {
    id: string;
    name?: string | null;
    type?: "user" | "registered_agent" | string;
  };
  status?: "active" | "completed" | "cancelled" | string;
  localTaskId?: string | null;
  localSessionId?: string | null;
  claimedAt: string;
  updatedAt: string;
}

export interface SpaceIssueDetail {
  issue: SpaceIssue;
  goalReference?: SpaceIssueGoalReference | null;
  comments: {
    items: SpaceIssueComment[];
    hasMore: boolean;
    hasMoreOlder?: boolean;
    nextCursor?: string | null;
    limit: number;
  };
  attachments: SpaceAttachment[];
  claim?: SpaceIssueClaim | null;
}

function normalizeSpaceIssueComment(comment: SpaceIssueComment): SpaceIssueComment {
  return {
    ...comment,
    attachments: Array.isArray(comment.attachments) ? comment.attachments : [],
  };
}

function normalizeSpaceIssueDetail(detail: SpaceIssueDetail): SpaceIssueDetail {
  return {
    ...detail,
    attachments: Array.isArray(detail.attachments) ? detail.attachments : [],
    comments: {
      ...detail.comments,
      items: (detail.comments?.items ?? []).map(normalizeSpaceIssueComment),
    },
  };
}

export interface SpaceSkill {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  currentRevision: number;
  latestRevision: number;
  uploader?: SpaceUserSummary | null;
  createdAt: string;
  updatedAt: string;
  source?: SpaceSkillSourceMeta | null;
}

export interface SpaceSkillSourceMeta {
  type: "github" | "raw_zip" | "url" | string;
  url: string;
  resolvedUrl?: string | null;
  owner?: string | null;
  repo?: string | null;
  ref?: string | null;
  effectiveRef?: string | null;
  rootPath?: string | null;
  skillName?: string | null;
  updatedAt?: string | null;
}

export interface SpaceSkillFile {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  isDir: boolean;
  sizeBytes?: number | null;
  mimeType?: string | null;
  createdAt: string;
}

export interface SpaceSkillDetail {
  skill: SpaceSkill;
  revision?: Record<string, unknown> | null;
  files: SpaceSkillFile[];
}

export interface SpaceSkillRevision {
  id: string;
  skillId?: string;
  revision: number;
  version?: string;
  packageHash?: string | null;
  packageStorageKey?: string | null;
  isCurrent: boolean;
  uploader?: SpaceUserSummary | null;
  createdAt: string;
}

export interface SpaceSkillRevisionHistory {
  skill: {
    id: string;
    currentRevision: number;
    latestRevision: number;
  };
  items: SpaceSkillRevision[];
}

export interface SpaceLocalSkill {
  id: string;
  name: string;
  description?: string | null;
  folderName: string;
  path: string;
  skillMdPath: string;
  scope: "global" | "project" | string;
  workspacePath?: string | null;
  workspaceLabel?: string | null;
}

export interface SpaceSkillSourceInspection {
  name: string;
  description?: string | null;
  fileCount: number;
  packageSizeBytes: number;
  packageHash: string;
  sourcePath: string;
}

export interface SpaceSkillUrlCandidate {
  suggestedFolderName: string;
  name: string;
  description: string;
  hasDangerousTools: boolean;
  rootPath: string;
}

export type SpaceSkillUrlPreview =
  | {
      mode: "multi";
      candidates: SpaceSkillUrlCandidate[];
    }
  | {
      mode: "marketplace";
      marketplaceName: string;
      marketplaceDescription?: string;
      plugins: Array<{
        name: string;
        description: string;
        skills: SpaceSkillUrlCandidate[];
      }>;
    };

export interface SpaceSkillUrlPackage extends SpaceSkillUrlCandidate {
  tempId: string;
  filePath: string;
  fileCount: number;
  packageSizeBytes: number;
  source?: SpaceSkillSourceMeta | null;
}

export interface SpaceSkillUrlExportResponse {
  success: boolean;
  mode?: "exported" | "multi" | "marketplace";
  packages?: SpaceSkillUrlPackage[];
  preview?: SpaceSkillUrlPreview;
  error?: string;
  sourceUrl?: string;
  effectiveRef?: string;
  source?: SpaceSkillSourceMeta | null;
}

export type SpaceIssueSubscriptionRunMode = "single_session" | "new_session";

export interface SpaceUserDeviceSummary {
  deviceId: string;
  deviceName?: string | null;
  platform?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
  status?: string | null;
  lastSeenAt?: string | null;
}

export interface LocalRegisteredAgent {
  id: string;
  baseUrl: string;
  spaceId: string;
  isLocal?: boolean;
  ownerUserId?: string | null;
  deviceId?: string | null;
  device?: SpaceUserDeviceSummary | null;
  clientId?: string | null;
  deviceName?: string | null;
  localWorkspaceId?: string | null;
  localAgentId?: string | null;
  workspaceId?: string | null;
  displayName: string;
  instruction: string | null;
  instructionRevision: number;
  workspacePath: string;
  workspaceLabel?: string | null;
  avatarUrl?: string | null;
  avatarSource?: "preset" | "r2" | string | null;
  avatarPresetId?: string | null;
  avatarUrls?: SpaceAvatarUrls | null;
  subscriptions: SpaceGoalSubscription[];
  goalId?: string | null;
  goalPathLabel?: string | null;
  stateFilter: string[];
  goalMd?: string | null;
  deliverySessionId?: string | null;
  issueSubscriptionRunMode: SpaceIssueSubscriptionRunMode;
  status: string;
  presence?: "online" | "offline";
  lastOnlineAt?: string | null;
  onlineUntil?: string | null;
  connecting?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceRegisteredAgent {
  id: string;
  spaceId: string;
  ownerUserId?: string | null;
  deviceId?: string | null;
  device?: SpaceUserDeviceSummary | null;
  clientId?: string | null;
  deviceName?: string | null;
  localWorkspaceId?: string | null;
  localAgentId?: string | null;
  displayName: string;
  instruction: string | null;
  instructionRevision: number;
  workspacePath?: string | null;
  workspaceLabel?: string | null;
  avatarUrl?: string | null;
  avatarSource?: "preset" | "r2" | string | null;
  avatarPresetId?: string | null;
  avatarUrls?: SpaceAvatarUrls | null;
  subscriptions?: SpaceGoalSubscription[];
  goalMd?: string | null;
  issueSubscriptionRunMode?: SpaceIssueSubscriptionRunMode | null;
  status: string;
  presence?: "online" | "offline";
  lastOnlineAt?: string | null;
  onlineUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceDispatchItem {
  dispatch: {
    id: string;
    spaceId: string;
    issueId: string;
    registeredAgentId: string;
    deliveryStatus: string;
    goalSnapshotMd: string;
    createdAt: string;
    updatedAt: string;
  };
  registeredAgent: {
    id: string;
    displayName: string;
    goalMd: string;
  };
  issueMeta: {
    id: string;
    number?: number | null;
    issueNumber?: number | null;
    title: string;
    status: string;
    updatedAt: string;
  };
}

export interface SpaceDeliveryItem {
  delivery: {
    id: string;
    spaceId: string;
    issueId: string;
    registeredAgentId: string;
    subscriptionId: string | null;
    deliveryKind: "subscription" | "assignment" | "claim_followup";
    deliveryReason: "issue_update" | "subscription_backfill" | "scope_reevaluation";
    claimId: string | null;
    targetSessionId: string | null;
    sourceIssueUpdateId: string;
    fromNotificationVersionExclusive: number;
    toNotificationVersionInclusive: number;
    protocolVersion: 2;
    status: "pending";
    createdAt: string;
  };
  issueMeta: {
    id: string;
    number?: number | null;
    issueNumber?: number | null;
    title: string;
    state: SpaceIssueState | string;
    assignee?: SpaceIdentitySummary | null;
    updatedAt: string;
  };
  goalMeta?: {
    id: string;
    path?: string | null;
    title?: string | null;
  } | null;
  sourceUpdate: {
    id: string;
    version: number;
    type: string;
    createdAt: string;
    actor: SpaceIdentitySummary;
    commentId: string | null;
    attachmentIds: string[];
  };
}

export interface SpaceDeliveryPollPackage {
  protocolVersion: 2;
  space: { id: string; name: string; slug: string };
  registeredAgent: {
    id: string;
    displayName: string;
    instruction: string | null;
    instructionRevision: number;
  };
  items: SpaceDeliveryItem[];
  poll: Record<string, unknown>;
}

export type SpaceEventType =
  | "space.plan_changed"
  | (string & Record<never, never>);

export interface SpaceEvent {
  id: string;
  type: SpaceEventType;
  resourceType?: string | null;
  resourceId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  targetRegisteredAgentId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface SpaceApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  requestId?: string;
  recoveryHint?: {
    message: string;
    recoveryCommand?: string;
  };
  quota?: string;
  limit?: number;
  usage?: number;
  hint?: string;
}

export interface SpaceErrorContext {
  method?: string;
  path?: string;
  operation?: string;
}

export interface NormalizedSpaceError {
  userMessage: string;
  debugMessage: string;
}

interface SpaceUserFacingError extends Error {
  readonly __spaceUserFacingError: true;
  readonly spaceCode?: string;
}

function spaceUserFacingError(
  message: string,
  details?: { code?: string },
): SpaceUserFacingError {
  const error = new Error(message) as SpaceUserFacingError;
  Object.defineProperty(error, "__spaceUserFacingError", { value: true });
  if (details?.code) {
    Object.defineProperty(error, "spaceCode", { value: details.code });
  }
  return error;
}

function isSpaceUserFacingError(error: unknown): error is SpaceUserFacingError {
  return (
    error instanceof Error &&
    (error as Partial<SpaceUserFacingError>).__spaceUserFacingError === true
  );
}

function rawErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "error" in error &&
    typeof error.error === "string"
  ) {
    return error.error;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function sanitizeSpaceError(message: string): string {
  return message
    .replace(/\s*\(https?:\/\/[^)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\/Users\/[^\s)]+/g, "[path]")
    .replace(/\/var\/folders\/[^\s)]+/g, "[path]")
    .replace(/[A-Z]:\\Users\\[^\s)]+/g, "[path]")
    .trim();
}

function spaceText(key: string, options?: Record<string, unknown>): string {
  return String(i18n.t(`app:space.errors.${key}`, options));
}

function operationFromPath(context?: SpaceErrorContext): string {
  if (context?.operation) return context.operation;
  const path = context?.path ?? "";
  const method = (context?.method ?? "").toUpperCase();
  if (method === "POST" && /\/api\/issues\/[^/]+\/comments$/.test(path))
    return spaceText("operations.comment");
  if (method === "POST" && /\/api\/spaces\/[^/]+\/issues$/.test(path))
    return spaceText("operations.createIssue");
  if (method === "PATCH" && /\/api\/issues\/[^/]+$/.test(path))
    return spaceText("operations.updateIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/status$/.test(path))
    return spaceText("operations.updateIssueStatus");
  if (method === "POST" && /\/api\/issues\/[^/]+\/close-own$/.test(path))
    return spaceText("operations.closeIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/claim$/.test(path))
    return spaceText("operations.claimIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/complete$/.test(path))
    return spaceText("operations.completeIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/cancel-claim$/.test(path))
    return spaceText("operations.cancelClaim");
  if (method === "POST" && path === "/api/spaces")
    return spaceText("operations.createSpace");
  if (method === "POST" && path === "/api/spaces/join")
    return spaceText("operations.joinSpace");
  if (path.includes("/goals")) return spaceText("operations.goal");
  if (path.includes("/attachments")) return spaceText("operations.attachment");
  if (path.includes("/skills")) return spaceText("operations.skill");
  return spaceText("operations.request");
}

export function normalizeSpaceError(
  error: unknown,
  context?: SpaceErrorContext,
): NormalizedSpaceError {
  if (isSpaceUserFacingError(error)) {
    return {
      userMessage: error.message,
      debugMessage: error.message,
    };
  }
  const raw = rawErrorMessage(error);
  const sanitized = sanitizeSpaceError(raw);
  const operation = operationFromPath(context);
  const lower = raw.toLowerCase();
  const envelope =
    error && typeof error === "object"
      ? (error as Partial<SpaceApiEnvelope<unknown>>)
      : null;
  const code = typeof envelope?.code === "string" ? envelope.code : "";
  const requestId =
    typeof envelope?.requestId === "string" ? envelope.requestId : "";
  const quota =
    typeof envelope?.quota === "string"
      ? envelope.quota
      : (raw.match(/\bquota=([A-Za-z0-9_]+)/)?.[1] ?? "");
  const rawLimit = Number(raw.match(/\blimit=(\d+)/)?.[1] ?? Number.NaN);
  const rawUsage = Number(raw.match(/\busage=(\d+)/)?.[1] ?? Number.NaN);
  const quotaLimit =
    typeof envelope?.limit === "number"
      ? envelope.limit
      : Number.isFinite(rawLimit)
        ? rawLimit
        : null;
  const quotaUsage =
    typeof envelope?.usage === "number"
      ? envelope.usage
      : Number.isFinite(rawUsage)
        ? rawUsage
        : null;
  const recoveryMessage =
    typeof envelope?.recoveryHint?.message === "string"
      ? envelope.recoveryHint.message.trim()
      : "";
  const debugSuffix = [code, requestId].filter(Boolean).join(" ");

  if (code === "SPACE_QUOTA_EXCEEDED" || raw.includes("SPACE_QUOTA_EXCEEDED")) {
    const quotaLabel = quota
      ? spaceText(`quotas.${quota}`)
      : spaceText("quotas.default");
    return {
      userMessage:
        quotaLimit !== null && quotaUsage !== null
          ? spaceText("templates.quotaExceededWithUsage", {
              operation,
              quota: quotaLabel,
              usage: quotaUsage,
              limit: quotaLimit,
            })
          : spaceText("templates.quotaExceeded", {
              operation,
              quota: quotaLabel,
            }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (code === "SPACE_SLUG_CONFLICT") {
    return {
      userMessage: spaceText("templates.slugConflict", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (code === "NOT_AUTHENTICATED" || code === "SESSION_EXPIRED") {
    return {
      userMessage: spaceText("templates.relogin", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (
    code === "FORBIDDEN" ||
    code.includes("PERMISSION") ||
    lower.includes("permission required")
  ) {
    return {
      userMessage: spaceText("templates.permissionDenied", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (code === "INTERNAL_ERROR") {
    return {
      userMessage: spaceText("templates.serviceUnavailable", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (recoveryMessage) {
    return {
      userMessage: spaceText("templates.withDetail", {
        operation,
        detail: recoveryMessage,
      }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (
    lower.includes("error sending request") ||
    lower.includes("space api request failed") ||
    lower.includes("load failed") ||
    lower.includes("network") ||
    lower.includes("timed out")
  ) {
    return {
      userMessage: spaceText("templates.network", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (
    lower.includes("invalid space api response") ||
    lower.includes("response missing data")
  ) {
    return {
      userMessage: spaceText("templates.invalidResponse", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (sanitized) {
    return {
      userMessage: spaceText("templates.withDetail", {
        operation,
        detail: sanitized,
      }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  return {
    userMessage: spaceText("templates.failed", { operation }),
    debugMessage: [debugSuffix, raw].filter(Boolean).join(" · "),
  };
}

export function spaceErrorMessage(
  error: unknown,
  context?: SpaceErrorContext,
): string {
  return normalizeSpaceError(error, context).userMessage;
}

export function isSpaceSkillInstallConflict(error: unknown): boolean {
  return String(error).includes("SKILL_INSTALL_CONFLICT");
}

export function spaceErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const maybeError = error as Partial<SpaceApiEnvelope<unknown>> & {
    spaceCode?: unknown;
  };
  if (typeof maybeError.spaceCode === "string") return maybeError.spaceCode;
  if (typeof maybeError.code === "string") return maybeError.code;
  return null;
}

export function isSpaceErrorCode(error: unknown, code: string): boolean {
  return spaceErrorCode(error) === code;
}

async function spaceApi<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let result: SpaceApiEnvelope<T>;
  try {
    result = await inv<SpaceApiEnvelope<T>>("cmd_space_api_request", {
      input: {
        method,
        path,
        body: body ?? null,
      },
    });
  } catch (error) {
    const normalized = normalizeSpaceError(error, { method, path });
    console.warn("[Space] API transport failed", {
      method,
      path,
      error: normalized.debugMessage,
    });
    throw spaceUserFacingError(normalized.userMessage);
  }
  if (!result.success) {
    const normalized = normalizeSpaceError(
      result.error ? result : `Space API failed: ${method} ${path}`,
      { method, path },
    );
    console.warn("[Space] API business error", {
      method,
      path,
      error: normalized.debugMessage,
    });
    throw spaceUserFacingError(normalized.userMessage, { code: result.code });
  }
  return result.data as T;
}

async function spaceMutationInvoke<T>(
  command: string,
  input: Record<string, unknown>,
  context: SpaceErrorContext,
): Promise<T> {
  try {
    return await inv<T>(command, { input });
  } catch (error) {
    const normalized = normalizeSpaceError(error, context);
    console.warn("[Space] mutation transport failed", {
      command,
      error: normalized.debugMessage,
    });
    throw spaceUserFacingError(normalized.userMessage);
  }
}

export function spaceGetSession(): Promise<SpaceSession | null> {
  return inv("cmd_space_get_session");
}

export function spaceSetActiveSpace(
  spaceId: string,
  expectedSessionBindingId: string,
): Promise<SpaceSession | null> {
  return inv("cmd_space_set_active_space", {
    input: { spaceId, expectedSessionBindingId },
  });
}

export function spaceGetCapability(): Promise<SpaceBuildCapability> {
  return inv("cmd_space_get_capability");
}

export function spaceAuthStart(): Promise<{
  loginToken: string;
  authorizationUrl: string;
  expiresInSeconds: number;
}> {
  return inv("cmd_space_auth_start");
}

export function spaceAuthPoll(
  loginToken: string,
): Promise<Record<string, unknown>> {
  return inv("cmd_space_auth_poll", { input: { loginToken } });
}

export function spaceAuthAck(loginToken: string): Promise<void> {
  return inv("cmd_space_auth_ack", { input: { loginToken } });
}

export function spaceLogout(): Promise<void> {
  return inv("cmd_space_logout");
}

export function spaceGetAvatarPresets(): Promise<{
  people: SpaceAvatarPreset[];
  agents: SpaceAvatarPreset[];
}> {
  return inv("cmd_space_get_avatar_presets");
}

export function spaceUpdateProfile(input: {
  name: string;
  avatarFilePath?: string | null;
  avatarPresetId?: string | null;
  nameChanged?: boolean;
}): Promise<SpaceSession> {
  return inv("cmd_space_update_profile", { input });
}

export function spaceUpdateSpace(input: {
  spaceId: string;
  name?: string;
  avatarFilePath?: string | null;
}): Promise<SpaceSession> {
  return inv("cmd_space_update_space", { input });
}

export function spaceListSpaces(): Promise<{
  user: SpaceUser;
  space: SpaceInfo;
  membership: SpaceMembership;
  spaces: SpaceListItem[];
}> {
  return spaceApi("GET", "/api/spaces");
}

export function spaceCreateSpace(input: { name: string; slug?: string }) {
  return spaceApi<{
    space: SpaceInfo;
    membership: SpaceMembership;
    limits: SpacePlanLimits;
  }>("POST", "/api/spaces", input);
}

export function spaceJoinSpace(input: { slug: string }) {
  return spaceApi<{
    status: "joined" | "pending" | string;
    space: SpaceInfo;
    membership?: SpaceMembership;
    joinRequest?: SpaceJoinRequest;
  }>("POST", "/api/spaces/join", input);
}

export function spaceGetOfficial(spaceId = DEFAULT_SPACE_ID): Promise<{
  space: SpaceInfo;
  membership: SpaceMembership;
  goals: SpaceGoal[];
  tags?: SpaceTag[];
  usage?: SpaceUsage | null;
  limits?: SpacePlanLimits;
}> {
  return spaceApi("GET", `/api/spaces/${spacePath(spaceId)}`);
}

export function spaceGetSpaceUsage(spaceId = DEFAULT_SPACE_ID) {
  return spaceApi<{ usage: SpaceUsage; limits: SpacePlanLimits }>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/usage`,
  );
}

export function spaceGetMembers(spaceId = DEFAULT_SPACE_ID) {
  return spaceApi<SpaceMembersPayload>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/members`,
  );
}

export function spaceUpdateMemberRole(input: {
  spaceId: string;
  memberId: string;
  role: "admin" | "member";
}) {
  return spaceApi<{ membership: SpaceMembership }>(
    "PATCH",
    `/api/spaces/${spacePath(input.spaceId)}/members/${encodeURIComponent(input.memberId)}`,
    { role: input.role },
  );
}

export function spaceRemoveMember(input: {
  spaceId: string;
  memberId: string;
}) {
  return spaceApi<{ removed: boolean; revokedRegisteredAgentIds?: string[] }>(
    "DELETE",
    `/api/spaces/${spacePath(input.spaceId)}/members/${encodeURIComponent(input.memberId)}`,
  );
}

export function spaceApproveJoinRequest(input: {
  spaceId: string;
  requestId: string;
}) {
  return spaceApi<{ approved: boolean; membership: SpaceMembership }>(
    "POST",
    `/api/spaces/${spacePath(input.spaceId)}/join-requests/${encodeURIComponent(input.requestId)}/approve`,
    {},
  );
}

export function spaceRejectJoinRequest(input: {
  spaceId: string;
  requestId: string;
}) {
  return spaceApi<{ rejected: boolean }>(
    "POST",
    `/api/spaces/${spacePath(input.spaceId)}/join-requests/${encodeURIComponent(input.requestId)}/reject`,
    {},
  );
}

export function spaceInviteMember(input: {
  spaceId: string;
  email: string;
  role?: "admin" | "member";
}) {
  return spaceApi<{
    status: "joined" | "invited" | string;
    membership?: SpaceMembership;
    invitation?: SpaceInvitation;
  }>("POST", `/api/spaces/${spacePath(input.spaceId)}/invitations`, {
    email: input.email,
    role: input.role ?? "member",
  });
}

export function spaceListGoals(
  input: { includeArchived?: boolean } = {},
  spaceId = DEFAULT_SPACE_ID,
) {
  const search = new URLSearchParams();
  if (input.includeArchived) search.set("includeArchived", "true");
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return spaceApi<{ items: SpaceGoal[] }>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/goals${suffix}`,
  );
}

export function spaceCreateGoal(
  input: { parentGoalId: string; title: string; context: string },
  spaceId = DEFAULT_SPACE_ID,
) {
  return spaceApi<{ goal: SpaceGoal }>(
    "POST",
    `/api/spaces/${spacePath(spaceId)}/goals`,
    input,
  );
}

export function spaceUpdateGoal(input: {
  goalId: string;
  title?: string;
  context?: string;
}) {
  return spaceApi<{ goal: SpaceGoal }>(
    "PATCH",
    `/api/goals/${encodeURIComponent(input.goalId)}`,
    {
      title: input.title,
      context: input.context,
    },
  );
}

export function spaceArchiveGoal(goalId: string) {
  return spaceApi<{ archived: boolean; archivedAt: string }>(
    "POST",
    `/api/goals/${encodeURIComponent(goalId)}/archive`,
    {},
  );
}

export function spaceListIssues(
  params: {
    q?: string;
    state?: string;
    goalId?: string | null;
    includeSubtree?: boolean;
    humanOnly?: boolean | null;
    related?: "me";
    cursor?: string;
    limit?: number;
  },
  spaceId = DEFAULT_SPACE_ID,
) {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.state) search.set("state", params.state);
  if (params.goalId) search.set("goalId", params.goalId);
  if (params.includeSubtree !== undefined)
    search.set("includeSubtree", String(params.includeSubtree));
  if (params.humanOnly !== undefined && params.humanOnly !== null)
    search.set("humanOnly", String(params.humanOnly));
  if (params.related) search.set("related", params.related);
  if (params.cursor) search.set("cursor", params.cursor);
  search.set("limit", String(params.limit ?? 30));
  return spaceApi<{
    items: SpaceIssue[];
    hasMore: boolean;
    nextCursor?: string | null;
  }>("GET", `/api/spaces/${spacePath(spaceId)}/issues?${search.toString()}`);
}

export function spaceListEvents(
  params: { cursor?: string | null; limit?: number; tail?: boolean },
  spaceId = DEFAULT_SPACE_ID,
) {
  const search = new URLSearchParams();
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.tail) search.set("tail", "1");
  search.set("limit", String(params.limit ?? 50));
  return spaceApi<{
    items: SpaceEvent[];
    hasMore: boolean;
    nextCursor?: string | null;
  }>("GET", `/api/spaces/${spacePath(spaceId)}/events?${search.toString()}`);
}

export function spaceCreateIssue(
  input: {
    title: string;
    body: string;
    goalId?: string | null;
    parentIssueId?: string | null;
    humanOnly?: boolean;
    assignee?: { type: "user" | "registered_agent"; id: string } | null;
    filePaths?: string[];
  },
  spaceId = DEFAULT_SPACE_ID,
) {
  return spaceMutationInvoke<{ issue: SpaceIssue; attachments?: SpaceAttachment[] }>(
    "cmd_space_create_issue_with_attachments",
    { ...input, spaceId, filePaths: input.filePaths ?? [] },
    { method: "POST", path: `/api/spaces/${spacePath(spaceId)}/issues` },
  );
}

export function spaceInspectAttachmentDrafts(filePaths: string[]) {
  return spaceMutationInvoke<SpaceAttachmentDraft[]>(
    "cmd_space_inspect_attachment_drafts",
    { filePaths },
    { method: "LOCAL", path: "/space/attachment-drafts/inspect" },
  );
}

export function spaceUpdateIssue(input: {
  issueId: string;
  title?: string;
  body?: string;
  goalId?: string | null;
}) {
  return spaceApi<{ issue: SpaceIssue }>(
    "PATCH",
    `/api/issues/${encodeURIComponent(input.issueId)}`,
    {
      title: input.title,
      body: input.body,
      goalId: input.goalId,
    },
  );
}

export async function spaceGetIssue(id: string) {
  const detail = await spaceApi<SpaceIssueDetail>(
    "GET",
    `/api/issues/${encodeURIComponent(id)}`,
  );
  return normalizeSpaceIssueDetail(detail);
}

export async function spaceListIssueComments(
  id: string,
  input: { cursor?: string | null; limit?: number } = {},
) {
  const search = new URLSearchParams({ limit: String(input.limit ?? 20) });
  if (input.cursor) search.set("cursor", input.cursor);
  const comments = await spaceApi<SpaceIssueDetail["comments"]>(
    "GET",
    `/api/issues/${encodeURIComponent(id)}/comments?${search.toString()}`,
  );
  return {
    ...comments,
    items: (comments.items ?? []).map(normalizeSpaceIssueComment),
  };
}

export async function spaceCommentIssue(id: string, body: string, filePaths: string[] = []) {
  const result = await spaceMutationInvoke<{ comment: SpaceIssueComment }>(
    "cmd_space_comment_issue_with_attachments",
    { issueId: id, body, filePaths },
    { method: "POST", path: `/api/issues/${encodeURIComponent(id)}/comments` },
  );
  return { comment: normalizeSpaceIssueComment(result.comment) };
}

export function spaceSetIssueState(id: string, state: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/status`,
    { state },
  );
}

export function spaceSetIssueAssignee(
  id: string,
  assignee: { type: "user" | "registered_agent"; id: string },
) {
  return spaceApi<{ issue: SpaceIssue }>(
    "PUT",
    `/api/issues/${encodeURIComponent(id)}/assignee`,
    { assignee },
  );
}

export function spaceCancelIssueAssignee(id: string) {
  return spaceApi<{ issue: SpaceIssue }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/assignee/cancel`,
    {},
  );
}

export function spaceCloseOwnIssue(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/close-own`,
    {},
  );
}

export function spaceCloseIssue(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/close`,
    {},
  );
}

export function spaceCompleteIssue(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/complete`,
    {},
  );
}

export function spaceCancelIssueClaim(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/cancel-claim`,
    {},
  );
}

export function spaceClaimIssue(id: string, deliveryId?: string | null) {
  return spaceApi<{ claim: SpaceIssueClaim }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/claim`,
    { deliveryId },
  );
}

export function spaceListSkills(spaceId = DEFAULT_SPACE_ID) {
  return spaceApi<{ items: SpaceSkill[] }>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/skills`,
  );
}

export function spaceGetSkill(id: string) {
  return spaceApi<SpaceSkillDetail>(
    "GET",
    `/api/skills/${encodeURIComponent(id)}`,
  );
}

export function spaceGetSkillFile(id: string, path: string) {
  const search = new URLSearchParams({ path });
  return spaceApi<{
    text?: string;
    binary?: boolean;
    mimeType?: string;
    sizeBytes?: number;
  }>(
    "GET",
    `/api/skills/${encodeURIComponent(id)}/file-content?${search.toString()}`,
  );
}

export function spaceListSkillRevisions(id: string) {
  return spaceApi<SpaceSkillRevisionHistory>(
    "GET",
    `/api/skills/${encodeURIComponent(id)}/revisions`,
  );
}

export function spaceRollbackSkill(id: string, revision: number) {
  return spaceApi<{ skill: SpaceSkill }>(
    "POST",
    `/api/skills/${encodeURIComponent(id)}/rollback`,
    { revision },
  );
}

export function spaceListLocalSkills(projects: Project[]) {
  return inv<SpaceLocalSkill[]>("cmd_space_list_local_skills", {
    input: {
      projects: projects.map((project) => ({
        workspacePath: project.path,
        workspaceLabel: project.displayName || project.name,
      })),
    },
  });
}

export function spaceInspectSkillSource(filePath: string) {
  return inv<SpaceSkillSourceInspection>("cmd_space_inspect_skill_source", {
    input: { filePath },
  });
}

export function spaceExportSkillFromUrl(input: {
  url: string;
  confirmedSelection?: {
    pluginName?: string;
    folderNames?: string[];
  };
}) {
  return inv<SpaceSkillUrlExportResponse>("cmd_space_export_skill_from_url", {
    input,
  });
}

export function spaceCleanupSkillExportPackages(filePaths: string[]) {
  return inv<void>("cmd_space_cleanup_skill_export_packages", {
    input: { filePaths },
  });
}

export function spaceInstallSkill(input: {
  skillId: string;
  skillName: string;
  target: "global" | "project";
  workspacePath?: string;
  overwrite?: boolean;
}) {
  return inv<{
    installedName: string;
    installedPath: string;
    target: string;
  }>("cmd_space_install_skill", {
    input,
  });
}

export function spaceUploadSkillZip(input: {
  filePath: string;
  name?: string;
  description?: string;
  skillId?: string;
  source?: SpaceSkillSourceMeta | null;
}) {
  return inv<{ skill: SpaceSkill }>("cmd_space_upload_skill", { input });
}

export function spaceDeleteSkill(skillId: string) {
  return spaceApi<{ deleted: boolean }>(
    "DELETE",
    `/api/skills/${encodeURIComponent(skillId)}`,
  );
}

export function spaceUploadIssueAttachments(input: {
  issueId: string;
  filePaths: string[];
}) {
  return inv<{ attachments: SpaceAttachment[] }>(
    "cmd_space_upload_issue_attachments",
    { input },
  );
}

export function spaceDownloadIssueAttachment(input: {
  attachmentId: string;
  workspacePath: string;
  issueId?: string;
  fileName?: string;
  output?: string;
}) {
  return inv<SpaceDownloadAttachmentResult>("cmd_space_download_attachment", {
    input,
  });
}

export function spaceRegisterAgent(input: {
  displayName: string;
  instruction: string;
  workspaceId: string;
  workspacePath: string;
  workspaceLabel?: string;
  goalId: string;
  stateFilter?: string[];
  issueSubscriptionRunMode?: SpaceIssueSubscriptionRunMode;
}) {
  return inv<LocalRegisteredAgent>("cmd_space_register_agent", { input });
}

export function spaceUpdateRegisteredAgent(input: {
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
}) {
  return inv<LocalRegisteredAgent>("cmd_space_update_registered_agent", {
    input,
  });
}

export function spaceUpdateRegisteredAgentAvatar(input: {
  id: string;
  avatarFilePath?: string | null;
  avatarPresetId?: string | null;
}) {
  return inv<LocalRegisteredAgent>("cmd_space_update_registered_agent_avatar", {
    input,
  });
}

export function spaceRevokeRegisteredAgent(id: string) {
  return inv<LocalRegisteredAgent>("cmd_space_revoke_registered_agent", {
    input: { id },
  });
}

export function spaceListRegisteredAgents(spaceId = DEFAULT_SPACE_ID) {
  return spaceApi<{ items: SpaceRegisteredAgent[] }>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/registered-agents`,
  );
}

export function spaceCreateRegisteredAgentSubscription(input: {
  spaceId: string;
  registeredAgentId: string;
  goalId: string;
  stateFilter: string[];
}) {
  return spaceApi<{ subscription: SpaceGoalSubscription }>(
    "POST",
    `/api/spaces/${spacePath(input.spaceId)}/subscriptions`,
    {
      actorType: "registered_agent",
      actorId: input.registeredAgentId,
      goalId: input.goalId,
      stateFilter: input.stateFilter,
    },
  );
}

export function spaceDeleteRegisteredAgentSubscription(subscriptionId: string) {
  return spaceApi<{ deleted: boolean }>(
    "DELETE",
    `/api/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

export function spaceReevaluateRegisteredAgent(id: string) {
  return spaceApi<{ reevaluated: boolean; subscriptionCount: number }>(
    "POST",
    `/api/registered-agents/${encodeURIComponent(id)}/re-evaluate-current-scope`,
  );
}

export function spaceListLocalAgents() {
  return inv<LocalRegisteredAgent[]>("cmd_space_list_local_agents");
}

export function spacePollDispatches(registeredAgentId: string) {
  return inv<SpaceApiEnvelope<{ items: SpaceDispatchItem[] }>>(
    "cmd_space_poll_dispatches",
    {
      input: { registeredAgentId },
    },
  );
}

export function spaceMarkDispatchDelivered(input: {
  registeredAgentId: string;
  dispatchId: string;
  localTaskId?: string;
  localRunId?: string;
}) {
  return inv<SpaceApiEnvelope<{ delivered: boolean; deliveredAt?: string }>>(
    "cmd_space_mark_dispatch_delivered",
    { input },
  );
}

export function spaceProcessDispatchesOnce() {
  return inv<{ processed: number; delivered: number; errors: string[] }>(
    "cmd_space_process_dispatches_once",
  );
}

export function spacePollDeliveries(registeredAgentId: string) {
  return inv<SpaceApiEnvelope<SpaceDeliveryPollPackage>>(
    "cmd_space_poll_deliveries",
    {
      input: { registeredAgentId },
    },
  );
}

export function spaceMarkDeliveryDelivered(input: {
  registeredAgentId: string;
  deliveryId: string;
  sessionId?: string;
}) {
  return inv<SpaceApiEnvelope<{ delivered: boolean; deliveredAt?: string }>>(
    "cmd_space_mark_delivery_delivered",
    { input },
  );
}

export function spaceProcessDeliveriesOnce() {
  return inv<{ processed: number; delivered: number; errors: string[] }>(
    "cmd_space_process_deliveries_once",
  );
}

export function spaceWakeConnector() {
  return inv<void>("cmd_space_wake_connector");
}

export function findProjectForAgent(
  projects: Project[],
  agent: LocalRegisteredAgent,
): Project | null {
  if (agent.workspaceId) {
    const byId = projects.find((project) => project.id === agent.workspaceId);
    if (byId) return byId;
  }
  return (
    projects.find((project) =>
      workspacePathsEqual(project.path, agent.workspacePath),
    ) ?? null
  );
}
