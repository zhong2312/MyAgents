import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw, X } from "lucide-react";

import {
  DEFAULT_SPACE_ID,
  spaceAuthAck,
  spaceAuthPoll,
  spaceAuthStart,
  spaceCreateSpace,
  spaceErrorMessage,
  isSpaceErrorCode,
  spaceJoinSpace,
  spaceWakeConnector,
  spaceUpdateSpace,
  type LocalRegisteredAgent,
  type SpaceIssue,
  type SpaceIssueSubscriptionRunMode,
  type SpaceListItem,
  type SpaceEvent,
  type SpaceRegisteredAgent,
  type SpaceUserDeviceSummary,
} from "@/api/spaceCloud";
import { type SelectOption } from "@/components/CustomSelect";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToast } from "@/components/Toast";
import { useConfig } from "@/hooks/useConfig";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import { getDeviceId, preloadDeviceId } from "@/identity/deviceIdentity";
import {
  ACTIVE_ISSUE_STATE_FILTER,
  ALL_ISSUE_STATE_FILTER,
  findJoinedSpaceBySlug,
  isRegisteredAgentVisibleInList,
  isSpaceAdmin,
  localAgentMatchesCurrentSpaceIdentity,
  spaceEventsRequireIssueListRefresh,
  spaceEventsRequireSessionRefresh,
  type IssueQueryParams,
} from "@/pages/space/spaceHelpers";
import {
  getIssueListState,
  SPACE_VISIBLE_REFRESH_TTL_MS,
} from "@/pages/space/spaceStore";
import { useSpaceData } from "@/pages/space/useSpaceData";
import { IssuesWorkspace } from "@/pages/space/issues/IssuesWorkspace";
import { CreateIssueDialog } from "@/pages/space/issues/CreateIssueDialog";
import { IssueDetailDrawer } from "@/pages/space/issues/IssueDetailDrawer";
import { RegisterAgentDialog } from "@/pages/space/agents/AgentsWorkspace";
import { SpaceSettingsWorkspace } from "@/pages/space/settings/SpaceSettingsWorkspace";
import { GoalsWorkspace } from "@/pages/space/goals/GoalsWorkspace";
import { GoalPathLabel } from "@/pages/space/GoalPathLabel";
import { SkillsWorkspace } from "@/pages/space/skills/SkillsWorkspace";
import {
  SpaceLogin,
  SpaceSidebar,
  type SpaceViewMode as ViewMode,
} from "@/pages/space/SpaceChrome";
import { SpaceIcon } from "@/pages/space/SpaceAvatar";
import SpaceProfileSettingsDialog from "@/pages/space/SpaceProfileSettingsDialog";
import {
  nowForSpaceMetric,
  recordSpaceMetric,
  trackSpaceAuth,
  withSpaceMutationMetric,
} from "@/pages/space/spaceMetrics";
import {
  PAPER_GRID_STYLE,
  SPACE_BACKGROUND_STYLE,
} from "@/pages/space/spaceUi";
import { spaceSlugCandidate } from "@/pages/space/spaceSlug";

const AUTH_POLL_DELAY_MS = 3000;
const AUTH_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const SPACE_EVENTS_SYNC_INTERVAL_MS = 15_000;
const AGENT_CONNECTING_WINDOW_MS = 75_000;

type IssueStatusSelection = {
  mode: "all" | "status";
  rememberedStatus: string;
};

function defaultIssueStatusSelection(): IssueStatusSelection {
  return {
    mode: "status",
    rememberedStatus: ACTIVE_ISSUE_STATE_FILTER,
  };
}

type SpaceQuickActionSubmitInput =
  | { mode: "join"; slug: string }
  | {
      mode: "create";
      name: string;
      slug: string;
      avatarFilePath?: string | null;
    };

type SpaceQuickActionError = {
  field: "slug";
  message: string;
};

async function readPickedImagePreview(
  fileService: ReturnType<typeof useWorkspaceFileService>,
  path: string,
): Promise<string> {
  const result = await fileService.readPathsAsBase64({ paths: [path] });
  const file = result.files[0];
  if (!file || file.error) {
    throw new Error(file?.error || "Avatar preview failed");
  }
  return `data:${file.mimeType};base64,${file.data}`;
}

export function SpaceQuickActionDialog({
  mode,
  busy,
  error,
  onClose,
  onClearError,
  onSubmit,
}: {
  mode: "join" | "create";
  busy: boolean;
  error?: SpaceQuickActionError | null;
  onClose: () => void;
  onClearError: () => void;
  onSubmit: (input: SpaceQuickActionSubmitInput) => void | Promise<void>;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const fileService = useWorkspaceFileService(null);
  const [joinSlug, setJoinSlug] = useState("");
  const [name, setName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [avatarFilePath, setAvatarFilePath] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  useCloseLayer(() => {
    if (busy) return false;
    onClose();
    return true;
  }, 220);
  const title =
    mode === "join"
      ? t("space.spaceActions.joinTitle")
      : t("space.spaceActions.createTitle");
  const busyLabel =
    mode === "join"
      ? t("space.spaceActions.joining")
      : t("space.spaceActions.creating");
  const slugError =
    mode === "create" && error?.field === "slug" ? error.message : null;
  const canSubmit =
    mode === "join"
      ? Boolean(joinSlug.trim())
      : Boolean(name.trim() && createSlug.trim());
  const submit = () => {
    if (!canSubmit || busy) return;
    if (mode === "join") {
      void onSubmit({ mode: "join", slug: joinSlug.trim() });
      return;
    }
    void onSubmit({
      mode: "create",
      name: name.trim(),
      slug: createSlug.trim(),
      avatarFilePath,
    });
  };
  const preventCreateOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.preventDefault();
  };
  const pickAvatar = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: t("space.profile.imageFilter"),
            extensions: ["png", "jpg", "jpeg", "webp"],
          },
        ],
      });
      if (!selected || Array.isArray(selected)) return;
      setAvatarFilePath(selected);
      setAvatarPreview(await readPickedImagePreview(fileService, selected));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };
  return (
    <OverlayBackdrop
      onClose={busy ? undefined : onClose}
      className="z-[220] items-center justify-center px-4 py-8"
    >
      <section className="w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="flex min-h-12 items-center justify-between border-b border-[var(--line-subtle)] px-4">
          <h2 className="text-lg font-semibold text-[var(--ink)]">{title}</h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {busy ? (
          <div
            className="flex min-h-32 flex-col items-center justify-center gap-3 p-4 text-sm font-medium text-[var(--ink-muted)]"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{busyLabel}</span>
          </div>
        ) : (
          <div className="space-y-3 p-4">
            {mode === "join" ? (
              <label className="block text-xs font-semibold text-[var(--ink-muted)]">
                {t("space.spaceActions.slug")}
                <input
                  value={joinSlug}
                  autoFocus
                  onChange={(event) => {
                    onClearError();
                    setJoinSlug(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submit();
                  }}
                  className="mt-1 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
                />
              </label>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <SpaceIcon name={name} avatarUrl={avatarPreview} size={44} />
                  <button
                    type="button"
                    onClick={pickAvatar}
                    disabled={busy}
                    className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-60"
                  >
                    {t("space.spaceActions.chooseAvatar")}
                  </button>
                </div>
                <label className="block text-xs font-semibold text-[var(--ink-muted)]">
                  {t("space.spaceActions.name")}
                  <input
                    value={name}
                    autoFocus
                    onChange={(event) => {
                      const nextName = event.target.value;
                      onClearError();
                      setName(nextName);
                      if (!slugEdited)
                        setCreateSlug(spaceSlugCandidate(nextName));
                    }}
                    onKeyDown={preventCreateOnEnter}
                    className="mt-1 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
                  />
                </label>
                <label className="block text-xs font-semibold text-[var(--ink-muted)]">
                  {t("space.spaceActions.slug")}
                  <input
                    value={createSlug}
                    onChange={(event) => {
                      onClearError();
                      setSlugEdited(true);
                      setCreateSlug(spaceSlugCandidate(event.target.value));
                    }}
                    onKeyDown={preventCreateOnEnter}
                    aria-invalid={slugError ? true : undefined}
                    className={`mt-1 h-10 w-full rounded-lg border bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)] ${slugError ? "border-[var(--error)]" : "border-[var(--line)]"}`}
                  />
                  {slugError ? (
                    <span
                      className="mt-1 block text-xs font-medium text-[var(--error)]"
                      role="alert"
                    >
                      {slugError}
                    </span>
                  ) : null}
                </label>
              </>
            )}
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {title}
            </button>
          </div>
        )}
      </section>
    </OverlayBackdrop>
  );
}

function errMessage(error: unknown): string {
  return spaceErrorMessage(error);
}

function agentIssueSubscriptionRunMode(
  value?: SpaceIssueSubscriptionRunMode | null,
): SpaceIssueSubscriptionRunMode {
  return value === "new_session" ? "new_session" : "single_session";
}

function normalizedIdentityValue(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mergeAgentDevice(
  agent: SpaceRegisteredAgent,
  localAgent: LocalRegisteredAgent | undefined,
): SpaceUserDeviceSummary | null {
  const source = agent.device ?? localAgent?.device ?? null;
  const deviceId = normalizedIdentityValue(
    agent.deviceId ??
      agent.device?.deviceId ??
      localAgent?.deviceId ??
      localAgent?.device?.deviceId,
  );
  if (!deviceId) return source;
  return {
    deviceId,
    deviceName:
      agent.device?.deviceName ??
      agent.deviceName ??
      localAgent?.device?.deviceName ??
      localAgent?.deviceName ??
      source?.deviceName,
    platform:
      agent.device?.platform ??
      localAgent?.device?.platform ??
      source?.platform,
    osVersion:
      agent.device?.osVersion ??
      localAgent?.device?.osVersion ??
      source?.osVersion,
    appVersion:
      agent.device?.appVersion ??
      localAgent?.device?.appVersion ??
      source?.appVersion,
    status:
      agent.device?.status ?? localAgent?.device?.status ?? source?.status,
    lastSeenAt:
      agent.device?.lastSeenAt ??
      localAgent?.device?.lastSeenAt ??
      source?.lastSeenAt,
  };
}

function registeredAgentToListItem(
  agent: SpaceRegisteredAgent,
  localAgent: LocalRegisteredAgent | undefined,
  fallbackBaseUrl: string,
  fallbackSpaceId: string,
  currentSpaceId: string,
  currentUserId: string | null,
  currentLocalDeviceId: string | null,
): LocalRegisteredAgent {
  const subscription = agent.subscriptions?.[0] ?? null;
  const cloudOwnerUserId = normalizedIdentityValue(agent.ownerUserId);
  const canUseLocalFallback = Boolean(
    cloudOwnerUserId &&
      currentUserId &&
      cloudOwnerUserId === currentUserId &&
      localAgentMatchesCurrentSpaceIdentity(
        localAgent,
        currentSpaceId,
        currentUserId,
        currentLocalDeviceId,
      ),
  );
  const localFallback = canUseLocalFallback ? localAgent : undefined;
  const ownerUserId = cloudOwnerUserId;
  const device = mergeAgentDevice(agent, localFallback);
  const deviceId = normalizedIdentityValue(
    device?.deviceId ?? agent.deviceId ?? localFallback?.deviceId,
  );
  const isLocal = Boolean(
    currentUserId &&
      currentLocalDeviceId &&
      ownerUserId === currentUserId &&
      deviceId === currentLocalDeviceId,
  );
  return {
    id: agent.id,
    baseUrl: localFallback?.baseUrl ?? fallbackBaseUrl,
    spaceId: agent.spaceId || localFallback?.spaceId || fallbackSpaceId,
    isLocal,
    ownerUserId,
    deviceId,
    device,
    clientId: agent.clientId ?? localFallback?.clientId,
    deviceName:
      device?.deviceName ?? agent.deviceName ?? localFallback?.deviceName,
    localWorkspaceId: agent.localWorkspaceId ?? localFallback?.localWorkspaceId,
    localAgentId: agent.localAgentId ?? localFallback?.localAgentId,
    workspaceId: localFallback?.workspaceId ?? agent.localWorkspaceId,
    displayName: agent.displayName || localFallback?.displayName || agent.id,
    instruction: agent.instruction,
    instructionRevision: agent.instructionRevision,
    workspacePath: agent.workspacePath ?? localFallback?.workspacePath ?? "",
    workspaceLabel: agent.workspaceLabel ?? localFallback?.workspaceLabel,
    avatarUrl: agent.avatarUrl ?? localFallback?.avatarUrl,
    avatarSource: agent.avatarSource ?? localFallback?.avatarSource,
    avatarPresetId: agent.avatarPresetId ?? localFallback?.avatarPresetId,
    avatarUrls: agent.avatarUrls ?? localFallback?.avatarUrls,
    subscriptions: agent.subscriptions ?? localFallback?.subscriptions ?? [],
    goalId: subscription?.goalId ?? localFallback?.goalId,
    goalPathLabel: subscription?.goalPathLabel ?? localFallback?.goalPathLabel,
    stateFilter: subscription?.stateFilter?.length
      ? subscription.stateFilter
      : (localFallback?.stateFilter ?? ["todo"]),
    goalMd: agent.goalMd ?? localFallback?.goalMd,
    deliverySessionId: localFallback?.deliverySessionId,
    issueSubscriptionRunMode: agentIssueSubscriptionRunMode(
      agent.issueSubscriptionRunMode ?? localFallback?.issueSubscriptionRunMode,
    ),
    status: agent.status || localFallback?.status || "active",
    presence: agent.presence ?? localFallback?.presence ?? "offline",
    lastOnlineAt: agent.lastOnlineAt ?? localFallback?.lastOnlineAt ?? null,
    onlineUntil: agent.onlineUntil ?? localFallback?.onlineUntil ?? null,
    createdAt: agent.createdAt || localFallback?.createdAt || "",
    updatedAt: agent.updatedAt || localFallback?.updatedAt || "",
  };
}

export default function Space({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const { projects } = useConfig();
  const spaceData = useSpaceData({ isActive });
  const { actions } = spaceData;
  const [authBusy, setAuthBusy] = useState(false);
  const [authFlow, setAuthFlow] = useState<{
    token: string;
    expiresAt: number;
  } | null>(null);
  const authPollWarningShownRef = useRef(false);
  const authPollWakeRef = useRef<(() => void) | null>(null);
  const previousModeRef = useRef<ViewMode>("issues");
  const [mode, setMode] = useState<ViewMode>("issues");
  const [issueQ, setIssueQ] = useState("");
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const [issueStatusSelection, setIssueStatusSelection] =
    useState<IssueStatusSelection>(defaultIssueStatusSelection);
  const selectedStatus =
    issueStatusSelection.mode === "all"
      ? ALL_ISSUE_STATE_FILTER
      : issueStatusSelection.rememberedStatus;
  const selectedStatusPreset = issueStatusSelection.rememberedStatus;
  const setSelectedStatus = useCallback((value: string) => {
    setIssueStatusSelection((current) =>
      value === ALL_ISSUE_STATE_FILTER
        ? { ...current, mode: "all" }
        : { mode: "status", rememberedStatus: value },
    );
  }, []);
  const resetIssueStatusSelection = useCallback(
    () =>
      setIssueStatusSelection((current) =>
        current.mode === "status" &&
        current.rememberedStatus === ACTIVE_ISSUE_STATE_FILTER
          ? current
          : defaultIssueStatusSelection(),
      ),
    [],
  );
  const [relatedToMeBySpace, setRelatedToMeBySpace] = useState<
    Record<string, boolean>
  >({});
  const [skillRemoteUpdateAvailable, setSkillRemoteUpdateAvailable] =
    useState(false);
  const [issueDetailId, setIssueDetailId] = useState<string | null>(null);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const [spaceDialogMode, setSpaceDialogMode] = useState<
    "join" | "create" | null
  >(null);
  const [spaceDialogBusy, setSpaceDialogBusy] = useState(false);
  const [spaceDialogError, setSpaceDialogError] =
    useState<SpaceQuickActionError | null>(null);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [connectingAgentUntil, setConnectingAgentUntil] = useState<
    Record<string, number>
  >({});

  const session = spaceData.session;
  const goals = spaceData.goals;
  const activeCacheSpaceId =
    spaceData.spaceId ||
    session?.space?.id ||
    session?.space?.slug ||
    DEFAULT_SPACE_ID;
  const activeDataScopeKey = `${spaceData.serviceBaseUrl?.trim() || session?.baseUrl?.trim() || ""}\n${activeCacheSpaceId}`;
  const relatedToMe = relatedToMeBySpace[activeCacheSpaceId] ?? false;
  const setRelatedToMe = useCallback(
    (next: boolean) => {
      setRelatedToMeBySpace((current) => ({
        ...current,
        [activeCacheSpaceId]: next,
      }));
    },
    [activeCacheSpaceId],
  );
  const issueQuery = useMemo<IssueQueryParams>(
    () => ({
      q: issueQ,
      goalId: selectedGoalId,
      includeSubtree: Boolean(selectedGoalId),
      state: selectedStatus,
      related: relatedToMe ? "me" : undefined,
      limit: 50,
    }),
    [issueQ, relatedToMe, selectedGoalId, selectedStatus],
  );
  const issueQueryRef = useRef(issueQuery);
  const issueList = getIssueListState(issueQuery);
  const previousSuccessfulIssuesRef = useRef<{
    scopeKey: string;
    items: SpaceIssue[];
  }>({ scopeKey: "", items: [] });
  useEffect(() => {
    if (issueList.lastFetchedAt <= 0) return;
    previousSuccessfulIssuesRef.current = {
      scopeKey: activeDataScopeKey,
      items: issueList.items,
    };
  }, [activeDataScopeKey, issueList.items, issueList.lastFetchedAt]);
  const showingPreviousIssues =
    issueList.lastFetchedAt === 0 &&
    previousSuccessfulIssuesRef.current.scopeKey === activeDataScopeKey &&
    previousSuccessfulIssuesRef.current.items.length > 0;
  const issues = showingPreviousIssues
    ? previousSuccessfulIssuesRef.current.items
    : issueList.items;
  const issueDetailNavigation = useMemo(() => {
    if (!issueDetailId) {
      return { previousIssueId: null, nextIssueId: null };
    }
    const currentIndex = issues.findIndex(
      (issue) => issue.id === issueDetailId,
    );
    if (currentIndex < 0) {
      return { previousIssueId: null, nextIssueId: null };
    }
    return {
      previousIssueId: currentIndex > 0 ? issues[currentIndex - 1].id : null,
      nextIssueId:
        currentIndex < issues.length - 1 ? issues[currentIndex + 1].id : null,
    };
  }, [issueDetailId, issues]);
  const issuesLoading =
    issueList.isLoading ||
    (spaceData.boot === "ready" &&
      issueList.lastFetchedAt === 0 &&
      !issueList.error);
  const skills = spaceData.skills.items;
  const skillsLoading =
    spaceData.skills.isLoading ||
    (spaceData.boot === "ready" &&
      spaceData.skills.lastFetchedAt === 0 &&
      !spaceData.skills.error);
  const localAgents = spaceData.localAgents.items;
  const registeredAgents = spaceData.registeredAgents.items;
  const currentUserId = session?.user?.id ?? null;
  const admin = isSpaceAdmin(session);
  const activeMode: ViewMode = !admin && mode === "settings" ? "issues" : mode;
  const issuePageLifecycleRef = useRef({
    scopeKey: activeDataScopeKey,
    pageActive: isActive && activeMode === "issues",
  });
  const currentIdentitySpaceId = session?.space?.id || activeCacheSpaceId;
  const spaceCacheKey = useCallback(
    (id: string) => `${activeCacheSpaceId}\n${id}`,
    [activeCacheSpaceId],
  );
  const baseAgents = useMemo<LocalRegisteredAgent[]>(() => {
    const localById = new Map(localAgents.map((agent) => [agent.id, agent]));
    const cloudItems = registeredAgents.map((agent) =>
      registeredAgentToListItem(
        agent,
        localById.get(agent.id),
        session?.baseUrl ?? "",
        activeCacheSpaceId,
        currentIdentitySpaceId,
        currentUserId,
        localDeviceId,
      ),
    );
    const cloudIds = new Set(cloudItems.map((agent) => agent.id));
    const localOnlyItems = localAgents
      .filter((agent) => !cloudIds.has(agent.id))
      .filter((agent) => {
        return localAgentMatchesCurrentSpaceIdentity(
          agent,
          currentIdentitySpaceId,
          currentUserId,
          localDeviceId,
        );
      })
      .map((agent) => {
        return {
          ...agent,
          isLocal: true,
        };
      });
    return [...cloudItems, ...localOnlyItems].filter(
      isRegisteredAgentVisibleInList,
    );
  }, [
    activeCacheSpaceId,
    currentIdentitySpaceId,
    currentUserId,
    localAgents,
    localDeviceId,
    registeredAgents,
    session?.baseUrl,
  ]);
  const agents = useMemo(
    () =>
      baseAgents.map((agent) => ({
        ...agent,
        connecting:
          agent.status === "active" &&
          agent.presence !== "online" &&
          (connectingAgentUntil[agent.id] ?? 0) > Date.now(),
      })),
    [baseAgents, connectingAgentUntil],
  );

  const markAgentConnecting = useCallback((agentId: string) => {
    setConnectingAgentUntil((current) => ({
      ...current,
      [agentId]: Date.now() + AGENT_CONNECTING_WINDOW_MS,
    }));
  }, []);

  useEffect(() => {
    const now = Date.now();
    let nextDeadline = Number.POSITIVE_INFINITY;
    let changed = false;
    const next: Record<string, number> = {};
    for (const [agentId, deadline] of Object.entries(connectingAgentUntil)) {
      const agent = baseAgents.find((item) => item.id === agentId);
      if (!agent || agent.presence === "online" || deadline <= now) {
        changed = true;
        continue;
      }
      next[agentId] = deadline;
      nextDeadline = Math.min(nextDeadline, deadline);
    }
    if (changed) setConnectingAgentUntil(next);
    if (!Number.isFinite(nextDeadline)) return;
    const timer = window.setTimeout(
      () =>
        setConnectingAgentUntil((current) => ({
          ...current,
        })),
      Math.max(0, nextDeadline - now + 25),
    );
    return () => window.clearTimeout(timer);
  }, [baseAgents, connectingAgentUntil]);

  useEffect(() => {
    let cancelled = false;
    preloadDeviceId()
      .then(() => {
        if (!cancelled) setLocalDeviceId(getDeviceId());
      })
      .catch(() => {
        if (!cancelled) setLocalDeviceId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const goalOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: "",
        label: t("space.filters.allGoals"),
        content: (
          <GoalPathLabel
            label={t("space.filters.allGoals")}
            leafLabel={t("space.filters.allGoals")}
          />
        ),
      },
      ...goals.map((goal) => {
        const label = goal.goalPathLabel || goal.title;
        return {
          value: goal.id,
          label,
          content: <GoalPathLabel label={label} leafLabel={goal.title} />,
        };
      }),
    ],
    [goals, t],
  );

  useEffect(() => {
    issueQueryRef.current = issueQuery;
  }, [issueQuery]);

  useEffect(() => {
    const nextPageActive = isActive && activeMode === "issues";
    const previous = issuePageLifecycleRef.current;
    issuePageLifecycleRef.current = {
      scopeKey: activeDataScopeKey,
      pageActive: nextPageActive,
    };
    if (
      nextPageActive &&
      (previous.scopeKey !== activeDataScopeKey || !previous.pageActive)
    ) {
      resetIssueStatusSelection();
    }
  }, [activeDataScopeKey, activeMode, isActive, resetIssueStatusSelection]);

  useEffect(() => {
    setSkillRemoteUpdateAvailable(false);
  }, [activeDataScopeKey]);

  useEffect(() => {
    if (spaceData.boot !== "ready") return;
    const reentered = previousModeRef.current !== activeMode;
    previousModeRef.current = activeMode;
    if (activeMode === "issues") {
      const handle = window.setTimeout(() => {
        const refreshes: Promise<void>[] = [
          actions.refreshIssues(issueQuery, {
            force: reentered,
            maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
          }),
          actions.refreshGoals({
            maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
          }),
        ];
        if (admin) {
          refreshes.push(
            actions.refreshRegisteredAgents({
              force: reentered,
              maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
            }),
          );
        }
        Promise.all(refreshes).catch((error) =>
          toast.error(spaceErrorMessage(error)),
        );
      }, 220);
      return () => window.clearTimeout(handle);
    }
    if (activeMode === "goals") {
      void actions
        .refreshGoals({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS })
        .catch((error) => toast.error(spaceErrorMessage(error)));
    }
    if (activeMode === "skills") {
      void actions
        .refreshSkills({
          force: reentered,
          maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
        })
        .then(() => {
          if (reentered) setSkillRemoteUpdateAvailable(false);
        })
        .catch((error) => toast.error(spaceErrorMessage(error)));
    }
    if (activeMode === "settings") {
      void Promise.all([
        actions.refreshGoals({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }),
        actions.refreshLocalAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }),
        actions.refreshRegisteredAgents({
          maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
        }),
      ]).catch((error) => toast.error(spaceErrorMessage(error)));
    }
  }, [
    actions,
    activeDataScopeKey,
    admin,
    issueQuery,
    activeMode,
    spaceData.boot,
    toast,
  ]);

  useEffect(() => {
    if (!isActive || spaceData.boot !== "ready") return;
    const startedAt = nowForSpaceMetric();
    void spaceWakeConnector()
      .then(() => {
        recordSpaceMetric("space_delivery_wake", {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: true,
        });
      })
      .catch((error) => {
        recordSpaceMetric("space_delivery_wake", {
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: false,
          error: spaceErrorMessage(error),
        });
      });
  }, [isActive, session?.baseUrl, session?.space?.id, spaceData.boot]);

  const revalidateForEvents = useCallback(
    async (events: SpaceEvent[]) => {
      if (events.length === 0) return;
      const startedAt = nowForSpaceMetric();
      recordSpaceMetric("space_tab_visible_revalidate_start", {
        count: events.length,
      });
      const issueRemoteUpdate = spaceEventsRequireIssueListRefresh(events);
      let skillRemoteUpdate = false;
      let refreshAgents = false;
      let refreshBoot = spaceEventsRequireSessionRefresh(events);

      for (const event of events) {
        const type = event.type;
        const resourceType = event.resourceType ?? "";
        if (resourceType === "skill" || type.startsWith("skill.")) {
          skillRemoteUpdate = true;
        }
        if (
          resourceType === "registered_agent" ||
          resourceType === "delivery" ||
          resourceType === "subscription" ||
          type.startsWith("registered_agent.") ||
          type.startsWith("delivery.") ||
          type.startsWith("subscription.")
        ) {
          refreshAgents = true;
        }
        if (resourceType === "goal" || type.startsWith("goal.")) {
          refreshBoot = true;
        }
        if (
          resourceType === "space" ||
          resourceType === "membership" ||
          resourceType === "join_request" ||
          resourceType === "invitation" ||
          type.startsWith("space.") ||
          type.startsWith("membership.") ||
          type.startsWith("join_request.") ||
          type.startsWith("invitation.")
        ) {
          refreshBoot = true;
        }
      }

      if (skillRemoteUpdate) setSkillRemoteUpdateAvailable(true);

      const jobs: Array<Promise<void>> = [];
      if (refreshBoot)
        jobs.push(actions.ensureBootstrapped({ force: true, silent: true }));
      if (issueRemoteUpdate) {
        jobs.push(
          actions.refreshIssues(issueQueryRef.current, {
            force: true,
            silent: true,
          }),
        );
      }
      if (issueDetailId && issueRemoteUpdate) {
        jobs.push(
          actions.refreshIssueDetail(issueDetailId, {
            force: true,
            silent: true,
          }),
        );
      }
      if (skillRemoteUpdate) {
        if (selectedSkillId) {
          jobs.push(
            actions.refreshSkillDetail(selectedSkillId, {
              force: true,
              silent: true,
            }),
          );
        }
      }
      if (refreshAgents) {
        jobs.push(actions.refreshLocalAgents({ force: true, silent: true }));
        jobs.push(
          actions.refreshRegisteredAgents({ force: true, silent: true }),
        );
      }
      try {
        await Promise.all(jobs);
        recordSpaceMetric("space_tab_visible_revalidate_end", {
          count: events.length,
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: true,
        });
      } catch (error) {
        recordSpaceMetric("space_tab_visible_revalidate_end", {
          count: events.length,
          durationMs: Math.round(nowForSpaceMetric() - startedAt),
          ok: false,
          error: spaceErrorMessage(error),
        });
        throw error;
      }
    },
    [actions, issueDetailId, selectedSkillId],
  );

  useEffect(() => {
    if (!isActive || spaceData.boot !== "ready") return;
    let cancelled = false;
    const sync = async () => {
      try {
        const events = await actions.syncEvents({
          maxAgeMs: 5_000,
          silent: true,
        });
        if (!cancelled) await revalidateForEvents(events);
      } catch (error) {
        if (!cancelled) toast.error(spaceErrorMessage(error));
      }
    };
    void sync();
    const handle = window.setInterval(() => {
      void sync();
    }, SPACE_EVENTS_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [actions, isActive, revalidateForEvents, spaceData.boot, toast]);

  useEffect(() => {
    if (!authFlow) return;
    let cancelled = false;

    const wakeAuthPoll = () => {
      authPollWakeRef.current?.();
    };

    const wakeAuthPollWhenVisible = () => {
      if (document.visibilityState === "visible") {
        wakeAuthPoll();
      }
    };

    const waitForNextPoll = (ms: number): Promise<void> => {
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        let timer: number | null = null;
        const finish = () => {
          if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
          }
          if (authPollWakeRef.current === finish) {
            authPollWakeRef.current = null;
          }
          resolve();
        };
        timer = window.setTimeout(finish, ms);
        authPollWakeRef.current = finish;
      });
    };

    const stopAuth = () => {
      authPollWarningShownRef.current = false;
      authPollWakeRef.current = null;
      setAuthFlow(null);
      setAuthBusy(false);
    };

    const poll = async () => {
      while (!cancelled && Date.now() < authFlow.expiresAt) {
        const startedAt = Date.now();
        try {
          const result = await spaceAuthPoll(authFlow.token);
          if (cancelled) return;
          if (result.status === "done") {
            stopAuth();
            toast.success(t("space.toasts.loginSuccess"));
            await actions.ensureBootstrapped({ force: true });
            trackSpaceAuth("success", true);
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn("[Space] auth ack failed:", errMessage(error));
            });
            return;
          }
          if (result.status === "failed") {
            stopAuth();
            toast.error(String(result.error ?? t("space.toasts.loginFailed")));
            trackSpaceAuth("failure", false, result.error ?? "failed");
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn("[Space] auth ack failed:", errMessage(error));
            });
            return;
          }
        } catch (_error) {
          if (cancelled) return;
          if (
            !authPollWarningShownRef.current &&
            Date.now() < authFlow.expiresAt
          ) {
            authPollWarningShownRef.current = true;
            toast.warning(t("space.toasts.loginSlow"));
          }
        }
        const elapsed = Date.now() - startedAt;
        await waitForNextPoll(Math.max(0, AUTH_POLL_DELAY_MS - elapsed));
      }

      if (!cancelled) {
        stopAuth();
        toast.error(t("space.toasts.loginTimeout"));
        trackSpaceAuth("failure", false, "timeout");
      }
    };

    window.addEventListener("focus", wakeAuthPoll);
    document.addEventListener("visibilitychange", wakeAuthPollWhenVisible);
    void poll();
    return () => {
      cancelled = true;
      wakeAuthPoll();
      window.removeEventListener("focus", wakeAuthPoll);
      document.removeEventListener("visibilitychange", wakeAuthPollWhenVisible);
    };
  }, [actions, authFlow, t, toast]);

  useEffect(() => {
    if (authFlow && isActive) {
      authPollWakeRef.current?.();
    }
  }, [authFlow, isActive]);

  const startLogin = useCallback(async () => {
    setAuthBusy(true);
    trackSpaceAuth("start", true);
    try {
      const result = await spaceAuthStart();
      const serverExpiresInMs =
        Number.isFinite(result.expiresInSeconds) && result.expiresInSeconds > 0
          ? result.expiresInSeconds * 1000
          : AUTH_POLL_TIMEOUT_MS;
      authPollWarningShownRef.current = false;
      setAuthFlow({
        token: result.loginToken,
        expiresAt:
          Date.now() + Math.min(serverExpiresInMs, AUTH_POLL_TIMEOUT_MS),
      });
      toast.info(t("space.toasts.browserLoginOpened"));
    } catch (error) {
      setAuthBusy(false);
      trackSpaceAuth("failure", false, error);
      toast.error(spaceErrorMessage(error));
    }
  }, [t, toast]);

  const selectSpaceTab = useCallback((next: ViewMode) => {
    setMode(next);
    setIssueDetailId(null);
  }, []);

  const refreshCurrent = useCallback(async () => {
    if (activeMode === "issues") {
      await actions.refreshIssues(issueQuery, { force: true });
    }
    if (activeMode === "goals") await actions.refreshGoals({ force: true });
    if (activeMode === "skills") {
      await actions.refreshSkills({ force: true });
      setSkillRemoteUpdateAvailable(false);
    }
    if (activeMode === "settings") {
      await Promise.all([
        actions.ensureBootstrapped({ force: true, silent: true }),
        actions.refreshGoals({ force: true }),
        actions.refreshLocalAgents({ force: true }),
        actions.refreshRegisteredAgents({ force: true }),
      ]);
    }
    toast.success(t("space.toasts.refreshed"));
  }, [actions, issueQuery, activeMode, t, toast]);

  const enterSpace = useCallback(
    async (spaceId: string, nextMode: ViewMode, target?: SpaceListItem) => {
      const switching = actions.switchSpace(spaceId, target);
      setIssueDetailId(null);
      setSelectedSkillId(null);
      setSelectedGoalId("");
      setMode(nextMode);
      await switching;
    },
    [actions],
  );

  const enterSpaceIssues = useCallback(
    (spaceId: string, target?: SpaceListItem) =>
      enterSpace(spaceId, "issues", target),
    [enterSpace],
  );

  const switchSpace = useCallback(
    async (spaceId: string, nextMode: ViewMode) => {
      try {
        await enterSpace(spaceId, nextMode);
      } catch (error) {
        toast.error(spaceErrorMessage(error));
      }
    },
    [enterSpace, toast],
  );

  const joinSpace = useCallback(() => {
    setSpaceDialogError(null);
    setSpaceDialogMode("join");
  }, []);

  const createSpace = useCallback(() => {
    setSpaceDialogError(null);
    setSpaceDialogMode("create");
  }, []);

  const submitSpaceDialog = useCallback(
    async (input: SpaceQuickActionSubmitInput) => {
      if (!spaceDialogMode || input.mode !== spaceDialogMode) return;
      setSpaceDialogError(null);
      const enterMutatedSpace = async (
        route: string,
        target?: SpaceListItem,
      ) => {
        try {
          await enterSpaceIssues(route, target);
        } catch (error) {
          // The Cloud mutation already succeeded and the target Space is visible.
          // A local last-active persistence failure must not turn success into failure.
          toast.warning(spaceErrorMessage(error));
        }
      };

      if (input.mode === "join") {
        const joinedSpace = findJoinedSpaceBySlug(session, input.slug);
        if (joinedSpace) {
          setSpaceDialogMode(null);
          toast.success(
            t("space.toasts.spaceAlreadyJoined", {
              name: joinedSpace.name,
            }),
          );
          await enterMutatedSpace(joinedSpace.slug || joinedSpace.id);
          return;
        }
      }

      setSpaceDialogBusy(true);
      try {
        if (input.mode === "join") {
          const result = await withSpaceMutationMetric("member.join", () =>
            spaceJoinSpace({ slug: input.slug }),
          );
          if (result.status === "joined") {
            await enterMutatedSpace(
              result.space.slug || result.space.id,
              result.membership
                ? { ...result.space, membership: result.membership }
                : undefined,
            );
          }
          toast.success(
            result.status === "pending"
              ? t("space.toasts.spaceJoinRequested")
              : t("space.toasts.spaceJoined"),
          );
        } else {
          const result = await withSpaceMutationMetric("settings.create", () =>
            spaceCreateSpace({
              name: input.name,
              slug: input.slug,
            }),
          );
          if (input.avatarFilePath) {
            try {
              await withSpaceMutationMetric("settings.update", () =>
                spaceUpdateSpace({
                  spaceId: result.space.id || result.space.slug,
                  avatarFilePath: input.avatarFilePath,
                }),
              );
            } catch (error) {
              toast.warning(spaceErrorMessage(error));
            }
          }
          await enterMutatedSpace(result.space.slug || result.space.id, {
            ...result.space,
            membership: result.membership,
            limits: result.limits ?? result.space.limits,
          });
          toast.success(t("space.toasts.spaceCreated"));
        }
        setSpaceDialogMode(null);
      } catch (error) {
        if (
          input.mode === "create" &&
          isSpaceErrorCode(error, "SPACE_SLUG_CONFLICT")
        ) {
          setSpaceDialogError({
            field: "slug",
            message: t("space.spaceActions.slugConflict"),
          });
        } else {
          toast.error(spaceErrorMessage(error));
        }
      } finally {
        setSpaceDialogBusy(false);
      }
    },
    [enterSpaceIssues, session, spaceDialogMode, t, toast],
  );

  const closeSpaceDialog = useCallback(() => {
    setSpaceDialogError(null);
    setSpaceDialogMode(null);
  }, []);

  const logout = useCallback(async () => {
    setIssueDetailId(null);
    resetIssueStatusSelection();
    try {
      await actions.logout();
      toast.success(t("space.toasts.logoutSuccess"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  }, [actions, resetIssueStatusSelection, t, toast]);

  if (spaceData.boot === "idle" || spaceData.boot === "loading") {
    return (
      <div
        className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]"
      >
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("space.common.loadingTeam")}
      </div>
    );
  }

  if (spaceData.boot === "error") {
    return (
      <div
        className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]"
      >
        <div className="text-center">
          <p>{spaceData.bootError ?? t("space.common.teamLoadFailed")}</p>
          <button
            type="button"
            onClick={() =>
              void actions
                .ensureBootstrapped({ force: true })
                .catch((error) => toast.error(spaceErrorMessage(error)))
            }
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            {t("space.common.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <SpaceLogin
        authBusy={authBusy}
        authFlow={authFlow}
        onLogin={startLogin}
      />
    );
  }

  return (
    <div
      className="relative h-full overflow-hidden bg-[var(--paper)]"
      style={SPACE_BACKGROUND_STYLE}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-20"
        style={PAPER_GRID_STYLE}
      />
      <div className="relative z-10 flex h-full min-h-0">
        <SpaceSidebar
          session={session}
          mode={activeMode}
          onSpaceTabChange={selectSpaceTab}
          onSpaceSwitch={switchSpace}
          onJoinSpace={joinSpace}
          onCreateSpace={createSpace}
          onLogout={logout}
          onOpenProfileSettings={() => setProfileSettingsOpen(true)}
          onRefreshAccountPlan={() =>
            actions.ensureBootstrapped({ force: true, silent: true })
          }
        />
        <section className="flex min-w-0 flex-1 flex-col">
          {activeMode === "issues" && (
            <IssuesWorkspace
              admin={admin}
              issues={issues}
              issuesLoading={issuesLoading}
              issueError={issueList.error}
              showingPreviousIssues={showingPreviousIssues}
              hasMore={issueList.hasMore}
              issueQ={issueQ}
              selectedGoalId={selectedGoalId}
              selectedStatus={selectedStatus}
              selectedStatusPreset={selectedStatusPreset}
              relatedToMe={relatedToMe}
              goalOptions={goalOptions}
              activeIssueId={issueDetailId}
              onQueryChange={setIssueQ}
              onGoalChange={setSelectedGoalId}
              onStatusChange={setSelectedStatus}
              onRelatedToMeChange={setRelatedToMe}
              onRefresh={refreshCurrent}
              onLoadMore={() => actions.loadMoreIssues(issueQuery)}
              onCreate={() => setCreateIssueOpen(true)}
              onOpenIssue={setIssueDetailId}
            />
          )}
          {activeMode === "skills" && (
            <SkillsWorkspace
              admin={admin}
              skills={skills}
              loading={skillsLoading}
              error={spaceData.skills.error}
              selectedSkillId={selectedSkillId}
              projects={projects}
              actions={actions}
              skillDetailState={
                selectedSkillId
                  ? spaceData.skillDetails[spaceCacheKey(selectedSkillId)]
                  : undefined
              }
              isActive={isActive}
              remoteUpdateAvailable={skillRemoteUpdateAvailable}
              onSelectSkill={setSelectedSkillId}
              onRefresh={refreshCurrent}
              onApplyRemoteUpdate={async () => {
                await actions.refreshSkills({ force: true });
                setSkillRemoteUpdateAvailable(false);
              }}
              onUploaded={(id) => setSelectedSkillId(id)}
            />
          )}
          {activeMode === "goals" && (
            <GoalsWorkspace
              admin={admin}
              session={session}
              goals={goals}
              actions={actions}
              onRefresh={() => actions.refreshGoals({ force: true })}
              onOpenIssuesForGoal={(goalId) => {
                setSelectedGoalId(goalId);
                selectSpaceTab("issues");
              }}
            />
          )}
          {activeMode === "settings" && admin && (
            <SpaceSettingsWorkspace
              session={session}
              agents={agents}
              goals={goals}
              projects={projects}
              actions={actions}
              avatarPresets={spaceData.avatarPresets}
              onRefresh={refreshCurrent}
              onRegister={() => setRegisterOpen(true)}
              isActive={isActive}
              onAgentConnecting={markAgentConnecting}
              onExit={() => selectSpaceTab("issues")}
            />
          )}
        </section>
      </div>

      {issueDetailId && (
        <IssueDetailDrawer
          issueId={issueDetailId}
          session={session}
          projects={projects}
          goals={goals}
          registeredAgents={spaceData.registeredAgents.items}
          detailState={spaceData.issueDetails[spaceCacheKey(issueDetailId)]}
          actions={actions}
          onClose={() => setIssueDetailId(null)}
          onNavigateIssue={setIssueDetailId}
          previousIssueId={issueDetailNavigation.previousIssueId}
          nextIssueId={issueDetailNavigation.nextIssueId}
          onChanged={() =>
            void actions.refreshIssues(issueQuery, {
              force: true,
              silent: true,
            })
          }
        />
      )}

      {createIssueOpen && (
        <CreateIssueDialog
          goals={goals}
          session={session}
          registeredAgents={spaceData.registeredAgents.items}
          actions={actions}
          issueQuery={issueQuery}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={(keepOpen) => {
            if (!keepOpen) setCreateIssueOpen(false);
            void actions.refreshIssues(issueQuery, {
              force: true,
              silent: true,
            });
          }}
        />
      )}

      {registerOpen && (
        <RegisterAgentDialog
          projects={projects}
          goals={goals}
          actions={actions}
          onClose={() => setRegisterOpen(false)}
          onRegistered={(agent) => {
            markAgentConnecting(agent.id);
            setRegisterOpen(false);
            void Promise.all([
              actions.refreshLocalAgents({ force: true, silent: true }),
              actions.refreshRegisteredAgents({ force: true, silent: true }),
            ]);
          }}
        />
      )}

      {profileSettingsOpen && (
        <SpaceProfileSettingsDialog
          session={session}
          actions={actions}
          avatarPresets={spaceData.avatarPresets}
          onClose={() => setProfileSettingsOpen(false)}
        />
      )}

      {spaceDialogMode && (
        <SpaceQuickActionDialog
          mode={spaceDialogMode}
          busy={spaceDialogBusy}
          error={spaceDialogError}
          onClose={closeSpaceDialog}
          onClearError={() => setSpaceDialogError(null)}
          onSubmit={submitSpaceDialog}
        />
      )}
    </div>
  );
}
