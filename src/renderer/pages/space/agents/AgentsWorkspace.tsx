import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bot,
  Camera,
  Check,
  Clock,
  Computer,
  Eye,
  FolderOpen,
  Loader2,
  Plus,
  Power,
  PowerOff,
  Settings,
  Target,
  Trash2,
  X,
} from "lucide-react";

import type {
  LocalRegisteredAgent,
  SpaceGoal,
  SpaceGoalSubscription,
  SpaceIssueSubscriptionRunMode,
} from "@/api/spaceCloud";
import CustomSelect, { type SelectOption } from "@/components/CustomSelect";
import ConfirmDialog from "@/components/ConfirmDialog";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToast } from "@/components/Toast";
import DropdownMenu, {
  type DropdownMenuSection,
} from "@/components/ui/DropdownMenu";
import type { Project } from "@/config/types";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { spaceErrorMessage } from "@/api/spaceCloud";
import {
  issueStatusLabel,
  registeredAgentAvailability,
  type AgentAvailability,
} from "@/pages/space/spaceHelpers";
import { GoalPathLabel } from "@/pages/space/GoalPathLabel";
import AvatarPicker, {
  type AvatarPickerSelection,
} from "@/pages/space/AvatarPicker";
import { SpaceAvatar } from "@/pages/space/SpaceAvatar";
import type {
  SpaceActions,
  SpaceAvatarPresetsState,
} from "@/pages/space/spaceStore";
import {
  SPACE_COLLECTION_FRAME_CLASS,
  SPACE_PRIMARY_TOOL_BUTTON_CLASS,
  SPACE_TWO_COLUMN_GRID_CLASS,
  formatTime,
} from "@/pages/space/spaceUi";
import { shortenPathForDisplay } from "@/utils/pathDetection";
import { workspacePathsEqual } from "../../../../shared/workspacePath";

const LEGACY_ISSUE_SUBSCRIPTION_RUN_MODE: SpaceIssueSubscriptionRunMode =
  "single_session";
const NEW_AGENT_ISSUE_SUBSCRIPTION_RUN_MODE: SpaceIssueSubscriptionRunMode =
  "new_session";
const DEFAULT_AGENT_STATE_FILTER = ["todo"];
const AGENT_SUBSCRIPTION_STATE_OPTIONS = ["todo", "open"] as const;
const MAX_AGENT_INSTRUCTION_CHARS = 20_000;

function instructionLength(value: string): number {
  return Array.from(value).length;
}

function stateFiltersEqual(left: string[], right: string[]): boolean {
  return (
    normalizeAgentStateFilter(left).join("\u0000") ===
    normalizeAgentStateFilter(right).join("\u0000")
  );
}

async function replaceVisibleAgentSubscription(
  actions: SpaceActions,
  registeredAgentId: string,
  current: SpaceGoalSubscription | null,
  goalId: string,
  stateFilter: string[],
): Promise<SpaceGoalSubscription> {
  const normalizedStateFilter = normalizeAgentStateFilter(stateFilter);
  if (
    current &&
    current.goalId === goalId &&
    stateFiltersEqual(current.stateFilter, normalizedStateFilter)
  ) {
    return current;
  }

  const create = () =>
    actions.createRegisteredAgentSubscription({
      registeredAgentId,
      goalId,
      stateFilter: normalizedStateFilter,
    });

  if (!current) return create();

  if (current.goalId !== goalId) {
    const replacement = await create();
    try {
      await actions.deleteRegisteredAgentSubscription(current.id);
      return replacement;
    } catch (error) {
      await actions
        .deleteRegisteredAgentSubscription(replacement.id)
        .catch(() => undefined);
      throw error;
    }
  }

  await actions.deleteRegisteredAgentSubscription(current.id);
  try {
    return await create();
  } catch (error) {
    await actions
      .createRegisteredAgentSubscription({
        registeredAgentId,
        goalId: current.goalId,
        stateFilter: current.stateFilter,
      })
      .catch(() => undefined);
    throw error;
  }
}

function AgentInstructionField({
  value,
  onChange,
  error,
  legacy = false,
  inputRef,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  legacy?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("app");
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[var(--ink)]">
        {t("space.agents.instructionLabel")}
      </span>
      <textarea
        ref={inputRef}
        aria-label={t("space.agents.instructionLabel")}
        value={value}
        disabled={disabled}
        rows={5}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("space.agents.instructionPlaceholder")}
        aria-invalid={Boolean(error)}
        className={`min-h-28 w-full resize-y rounded-lg border bg-[var(--paper)] px-3 py-2.5 text-sm leading-6 text-[var(--ink)] outline-none transition-colors disabled:opacity-60 ${
          error
            ? "border-[var(--error)] focus:border-[var(--error)]"
            : "border-[var(--line)] focus:border-[var(--accent-warm)]"
        }`}
      />
      {error ? (
        <p className="mt-1 text-xs font-medium text-[var(--error)]">{error}</p>
      ) : legacy ? (
        <p className="mt-1 text-xs text-[var(--warning)]">
          {t("space.agents.instructionLegacyWarning")}
        </p>
      ) : null}
    </label>
  );
}

function normalizeIssueSubscriptionRunMode(
  value?: SpaceIssueSubscriptionRunMode | null,
): SpaceIssueSubscriptionRunMode {
  return value === "new_session"
    ? "new_session"
    : LEGACY_ISSUE_SUBSCRIPTION_RUN_MODE;
}

function issueSubscriptionRunModeLabel(
  t: ReturnType<typeof useTranslation>["t"],
  mode?: SpaceIssueSubscriptionRunMode | null,
): string {
  return normalizeIssueSubscriptionRunMode(mode) === "new_session"
    ? t("space.agents.issueSubscriptionNewSession")
    : t("space.agents.issueSubscriptionSingleSession");
}

function issueStateFilterLabel(
  t: ReturnType<typeof useTranslation>["t"],
  states?: string[] | null,
): string {
  return normalizeAgentStateFilter(states)
    .map((state) => issueStatusLabel(state, t))
    .join(", ");
}

function normalizeAgentStateFilter(states?: string[] | null): string[] {
  const allowed = new Set<string>(AGENT_SUBSCRIPTION_STATE_OPTIONS);
  const selected = new Set(
    (states?.length ? states : DEFAULT_AGENT_STATE_FILTER)
      .map((state) => state.trim().toLowerCase())
      .filter((state) => allowed.has(state)),
  );
  const normalized = AGENT_SUBSCRIPTION_STATE_OPTIONS.filter((state) =>
    selected.has(state),
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_AGENT_STATE_FILTER];
}

function agentStatusClass(availability: AgentAvailability): string {
  if (availability === "online")
    return "border border-[var(--success)]/20 bg-[var(--success-bg)] text-[var(--success)]";
  if (availability === "connecting")
    return "border border-[var(--accent-warm)]/20 bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]";
  return "border border-[var(--line-subtle)] bg-[var(--paper-inset)] text-[var(--ink-muted)]";
}

function agentStatusLabel(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return t(`space.agents.${registeredAgentAvailability(agent)}`);
}

function agentTargetLabel(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const target = agent.goalPathLabel?.trim() || agent.goalId?.trim();
  return target || t("space.agents.targetNotSet");
}

function agentSubscriptionLabels(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (agent.subscriptions.length === 0)
    return t("space.agents.noSubscriptions");
  return agent.subscriptions
    .map((subscription) => subscription.goalPathLabel || subscription.goalId)
    .join(" · ");
}

function agentInstructionSummary(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return (
    agent.instruction?.trim() || t("space.agents.instructionLegacyWarning")
  );
}

function agentCardTimeLabel(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const availability = registeredAgentAvailability(agent);
  if (availability === "connecting") return t("space.agents.connectingHint");
  const lastOnline = formatTime(agent.lastOnlineAt ?? "");
  if (lastOnline) return t("space.agents.lastOnlineAt", { time: lastOnline });
  if (availability === "online") return t("space.agents.clientOnline");
  return t("space.agents.neverOnline");
}

function shortDeviceId(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function localComputerLabel(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const deviceName =
    agent.device?.deviceName?.trim() || agent.deviceName?.trim();
  if (deviceName) return deviceName;
  const deviceId = shortDeviceId(agent.device?.deviceId ?? agent.deviceId);
  return deviceId || t("space.agents.unknownDevice");
}

function agentWorkspacePathLabel(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const path = agent.workspacePath?.trim();
  if (path) return shortenPathForDisplay(path);
  return (
    agent.workspaceLabel?.trim() || t("space.agents.workspacePathUnavailable")
  );
}

function projectLabel(project: Project): string {
  return project.displayName || project.name;
}

function findAgentProject(
  agent: LocalRegisteredAgent,
  projects: Project[],
): Project | undefined {
  const workspaceId = agent.localWorkspaceId || agent.workspaceId;
  return (
    (workspaceId
      ? projects.find((project) => project.id === workspaceId)
      : undefined) ??
    projects.find((project) =>
      workspacePathsEqual(project.path, agent.workspacePath),
    )
  );
}

function optionalDetail(
  value: string | null | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function localityLabel(
  agent: LocalRegisteredAgent,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (agent.isLocal === true) return t("space.agents.currentDevice");
  return t("space.agents.remoteDevice");
}

type AgentPrimaryOverlay =
  | { kind: "details"; agentId: string }
  | { kind: "editor"; agent: LocalRegisteredAgent }
  | null;

export function AgentsWorkspace({
  admin,
  agents,
  goals,
  projects,
  actions,
  avatarPresets,
  onRegister,
  registerDisabled = false,
  registerDisabledHint,
  isActive,
  onAgentConnecting,
}: {
  admin: boolean;
  agents: LocalRegisteredAgent[];
  goals: SpaceGoal[];
  projects: Project[];
  actions: SpaceActions;
  avatarPresets: SpaceAvatarPresetsState;
  onRegister: () => void;
  registerDisabled?: boolean;
  registerDisabledHint?: string;
  isActive: boolean;
  onAgentConnecting: (agentId: string) => void;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [primaryOverlay, setPrimaryOverlay] =
    useState<AgentPrimaryOverlay>(null);
  const [revokeTarget, setRevokeTarget] = useState<LocalRegisteredAgent | null>(
    null,
  );
  const [presenceStale, setPresenceStale] = useState(false);
  const selectedAgent =
    primaryOverlay?.kind === "details"
      ? (agents.find((agent) => agent.id === primaryOverlay.agentId) ?? null)
      : null;
  const editingAgent =
    primaryOverlay?.kind === "editor" ? primaryOverlay.agent : null;

  const toggleAgentStatus = async (agent: LocalRegisteredAgent) => {
    const nextStatus = agent.status === "disabled" ? "active" : "disabled";
    setBusyAgentId(agent.id);
    try {
      await actions.updateRegisteredAgent({ id: agent.id, status: nextStatus });
      if (nextStatus === "active") onAgentConnecting(agent.id);
      toast.success(
        nextStatus === "active"
          ? t("space.toasts.agentEnabled")
          : t("space.toasts.agentDisabled"),
      );
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyAgentId(null);
    }
  };

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const refreshPresence = (preserveOrder = true) => {
      if (document.visibilityState !== "visible") return;
      void actions
        .refreshRegisteredAgents({ force: true, silent: preserveOrder })
        .then(() => {
          if (!cancelled) setPresenceStale(false);
        })
        .catch(() => {
          if (!cancelled) setPresenceStale(true);
        });
    };
    refreshPresence(false);
    const handle = window.setInterval(() => refreshPresence(true), 60_000);
    const refreshWhenVisible = () => refreshPresence(true);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [actions, isActive]);
  const revokeAgent = async () => {
    if (!revokeTarget) return;
    setBusyAgentId(revokeTarget.id);
    try {
      await actions.revokeRegisteredAgent(revokeTarget.id);
      toast.success(t("space.toasts.agentRevoked"));
      setRevokeTarget(null);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <>
      <div className={`${SPACE_COLLECTION_FRAME_CLASS} space-y-3`}>
        <section className="flex min-h-10 items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold text-[var(--ink-secondary)]">
            <Bot className="h-4 w-4 shrink-0" />
            <h2 className="truncate">Agents</h2>
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
              {agents.length}
            </span>
          </div>
          {admin && (
            <button
              type="button"
              onClick={onRegister}
              disabled={registerDisabled}
              title={registerDisabledHint}
              className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
            >
              <Plus className="h-4 w-4" />
              {t("space.agents.register")}
            </button>
          )}
        </section>
        {presenceStale ? (
          <div className="rounded-xl border border-[var(--warning)]/20 bg-[var(--warning-bg)] px-3 py-2 text-xs font-semibold text-[var(--warning)]">
            {t("space.agents.presenceMayBeStale")}
          </div>
        ) : null}
        {agents.length === 0 ? (
          <div className="grid h-40 place-items-center rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper-elevated)]/40 text-sm text-[var(--ink-muted)]">
            <div className="text-center">
              <Bot className="mx-auto mb-3 h-8 w-8 text-[var(--ink-muted)]" />
              <p>{t("space.agents.empty")}</p>
              {admin && (
                <button
                  type="button"
                  onClick={onRegister}
                  disabled={registerDisabled}
                  title={registerDisabledHint}
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" />
                  {t("space.agents.registerAgent")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className={SPACE_TWO_COLUMN_GRID_CLASS}>
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                admin={admin}
                busy={busyAgentId === agent.id}
                t={t}
                onOpen={() =>
                  setPrimaryOverlay({ kind: "details", agentId: agent.id })
                }
                onEdit={() => setPrimaryOverlay({ kind: "editor", agent })}
                onToggle={() => void toggleAgentStatus(agent)}
                onRevoke={() => setRevokeTarget(agent)}
              />
            ))}
          </div>
        )}
      </div>
      {selectedAgent && (
        <AgentDetailOverlay
          agent={selectedAgent}
          admin={admin}
          busy={busyAgentId === selectedAgent.id}
          t={t}
          actions={actions}
          avatarPresets={avatarPresets}
          onClose={() => setPrimaryOverlay(null)}
          onEdit={() =>
            setPrimaryOverlay({ kind: "editor", agent: selectedAgent })
          }
          onToggle={() => void toggleAgentStatus(selectedAgent)}
          onRevoke={() => setRevokeTarget(selectedAgent)}
        />
      )}
      {editingAgent && (
        <EditAgentDialog
          agent={editingAgent}
          goals={goals}
          projects={projects}
          actions={actions}
          onClose={() => setPrimaryOverlay(null)}
          onSaved={() => setPrimaryOverlay(null)}
        />
      )}
      {revokeTarget && (
        <ConfirmDialog
          title={t("space.agents.revokeTitle")}
          message={t("space.agents.revokeMessage", {
            name: revokeTarget.displayName,
          })}
          confirmText={t("space.agents.revoke")}
          cancelText={t("space.common.cancel")}
          confirmVariant="danger"
          loading={busyAgentId === revokeTarget.id}
          onConfirm={() => void revokeAgent()}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </>
  );
}

function EditAgentDialog({
  agent,
  goals,
  projects,
  actions,
  onClose,
  onSaved,
}: {
  agent: LocalRegisteredAgent;
  goals: SpaceGoal[];
  projects: Project[];
  actions: SpaceActions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [instruction, setInstruction] = useState(agent.instruction ?? "");
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const canEditWorkspace = agent.isLocal === true;
  const currentProject = useMemo(
    () => findAgentProject(agent, projects),
    [agent, projects],
  );
  const currentWorkspaceId =
    agent.localWorkspaceId || agent.workspaceId || "current-agent-workspace";
  const [workspaceId, setWorkspaceId] = useState(
    currentProject?.id ?? currentWorkspaceId,
  );
  const [visibleSubscription, setVisibleSubscription] =
    useState<SpaceGoalSubscription | null>(agent.subscriptions[0] ?? null);
  const visibleGoalId = visibleSubscription?.goalId ?? agent.goalId ?? "";
  const [goalId, setGoalId] = useState(visibleGoalId || goals[0]?.id || "");
  const [stateFilter, setStateFilter] = useState<string[]>(() =>
    normalizeAgentStateFilter(
      visibleSubscription?.stateFilter ?? agent.stateFilter,
    ),
  );
  const [issueSubscriptionRunMode, setIssueSubscriptionRunMode] =
    useState<SpaceIssueSubscriptionRunMode>(
      normalizeIssueSubscriptionRunMode(agent.issueSubscriptionRunMode),
    );
  const [busy, setBusy] = useState(false);

  const projectOptions = useMemo<SelectOption[]>(() => {
    const options = projects.map((project) => ({
      value: project.id,
      label: projectLabel(project),
    }));
    if (!options.some((option) => option.value === workspaceId)) {
      options.unshift({
        value: workspaceId,
        label:
          agent.workspaceLabel?.trim() || agentWorkspacePathLabel(agent, t),
      });
    }
    return options;
  }, [agent, projects, t, workspaceId]);

  const goalOptions = useMemo<SelectOption[]>(() => {
    const options = goals.map((goal) => {
      const label = goal.goalPathLabel || goal.title;
      return {
        value: goal.id,
        label,
        content: <GoalPathLabel label={label} leafLabel={goal.title} />,
      };
    });
    if (
      visibleGoalId &&
      !options.some((option) => option.value === visibleGoalId)
    ) {
      const label =
        visibleSubscription?.goalPathLabel?.trim() ||
        agentTargetLabel(agent, t);
      options.unshift({
        value: visibleGoalId,
        label,
        content: <GoalPathLabel label={label} leafLabel={label} />,
      });
    }
    return options;
  }, [agent, goals, t, visibleGoalId, visibleSubscription?.goalPathLabel]);

  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const submit = async () => {
    const selectedProject = canEditWorkspace
      ? projects.find((project) => project.id === workspaceId)
      : undefined;
    const nextWorkspace: {
      workspaceId?: string;
      workspacePath?: string;
      workspaceLabel?: string;
    } = canEditWorkspace
      ? selectedProject
        ? {
            workspaceId: selectedProject.id,
            workspacePath: selectedProject.path,
            workspaceLabel: projectLabel(selectedProject),
          }
        : {
            workspaceId: agent.localWorkspaceId || agent.workspaceId || "",
            workspacePath: agent.workspacePath,
            workspaceLabel: agent.workspaceLabel ?? undefined,
          }
      : {};
    const normalizedInstruction = instruction.trim();
    if (agent.instruction !== null && !normalizedInstruction) {
      setInstructionError(t("space.agents.instructionRequired"));
      instructionRef.current?.focus();
      return;
    }
    if (
      instructionLength(normalizedInstruction) > MAX_AGENT_INSTRUCTION_CHARS
    ) {
      setInstructionError(t("space.agents.instructionTooLong"));
      instructionRef.current?.focus();
      return;
    }
    setInstructionError(null);
    if (!displayName.trim()) return;
    if (
      canEditWorkspace &&
      (!nextWorkspace.workspaceId || !nextWorkspace.workspacePath)
    )
      return;
    if ((visibleSubscription || goalOptions.length > 0) && !goalId) return;
    setBusy(true);
    try {
      if (goalId) {
        const nextSubscription = await replaceVisibleAgentSubscription(
          actions,
          agent.id,
          visibleSubscription,
          goalId,
          stateFilter,
        );
        setVisibleSubscription(nextSubscription);
      }
      await actions.updateRegisteredAgent({
        id: agent.id,
        displayName: displayName.trim(),
        ...(normalizedInstruction &&
        normalizedInstruction !== (agent.instruction ?? "").trim()
          ? {
              instruction: normalizedInstruction,
              expectedInstructionRevision: agent.instructionRevision,
            }
          : {}),
        ...nextWorkspace,
        issueSubscriptionRunMode,
      });
      toast.success(t("space.toasts.agentUpdated"));
      onSaved();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("REGISTERED_AGENT_INSTRUCTION_CONFLICT")) {
        setInstructionError(t("space.agents.instructionConflict"));
        instructionRef.current?.focus();
      } else {
        toast.error(spaceErrorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop
      onClose={onClose}
      className="z-[220] items-center justify-center bg-black/20 p-6 backdrop-blur-sm max-sm:p-3"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("space.agents.editTitle")}
        className="grid max-h-[calc(100dvh-48px)] w-full max-w-[720px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl max-sm:max-h-[calc(100dvh-24px)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">
              {t("space.agents.editTitle")}
            </h2>
            <p className="text-sm text-[var(--ink-muted)]">{agent.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">
              {t("space.agents.name")}
            </span>
            <input
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
            />
          </label>
          <AgentInstructionField
            value={instruction}
            onChange={(value) => {
              setInstruction(value);
              if (instructionError) setInstructionError(null);
            }}
            error={instructionError}
            legacy={agent.instruction === null}
            inputRef={instructionRef}
            disabled={busy}
          />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">
              {t("space.agents.localAgentWorkspace")}
            </span>
            {canEditWorkspace ? (
              <CustomSelect
                value={workspaceId}
                options={projectOptions}
                onChange={setWorkspaceId}
                size="md"
              />
            ) : (
              <>
                <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)]/55 px-3 py-2.5">
                  <p className="truncate text-sm font-semibold text-[var(--ink-secondary)]">
                    {agent.workspaceLabel?.trim() ||
                      agentWorkspacePathLabel(agent, t)}
                  </p>
                  {agent.workspacePath ? (
                    <p className="mt-1 truncate font-mono text-xs text-[var(--ink-muted)]">
                      {agentWorkspacePathLabel(agent, t)}
                    </p>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-[var(--ink-muted)]">
                  {t("space.agents.remoteWorkspaceLocked", {
                    device: localComputerLabel(agent, t),
                  })}
                </p>
              </>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">
              {t("space.agents.subscriptionTarget")}
            </span>
            {goalOptions.length > 0 ? (
              <CustomSelect
                value={goalId}
                options={goalOptions}
                onChange={setGoalId}
                size="md"
              />
            ) : (
              <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2.5 text-sm font-semibold text-[var(--ink-subtle)]">
                {t("space.agents.targetNotSet")}
              </div>
            )}
          </label>
          <IssueSubscriptionScopeControl
            value={stateFilter}
            onChange={setStateFilter}
            disabled={busy || !goalId}
          />
          <IssueSubscriptionRunModeControl
            value={issueSubscriptionRunMode}
            onChange={setIssueSubscriptionRunMode}
            disabled={busy}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-10 rounded-xl bg-[var(--button-secondary-bg)] px-4 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-60"
          >
            {t("space.common.cancel")}
          </button>
          <button
            type="button"
            disabled={
              busy ||
              !displayName.trim() ||
              instructionLength(instruction.trim()) >
                MAX_AGENT_INSTRUCTION_CHARS ||
              (agent.instruction !== null && !instruction.trim()) ||
              ((visibleSubscription !== null || goalOptions.length > 0) &&
                (!goalId || stateFilter.length === 0)) ||
              (canEditWorkspace && !workspaceId)
            }
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("space.common.save")}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function AgentCard({
  agent,
  admin,
  busy,
  t,
  onOpen,
  onEdit,
  onToggle,
  onRevoke,
}: {
  agent: LocalRegisteredAgent;
  admin: boolean;
  busy: boolean;
  t: ReturnType<typeof useTranslation>["t"];
  onOpen: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const revoked = agent.status === "revoked";
  const managementDisabled = agent.status !== "active";
  const availability = registeredAgentAvailability(agent);

  return (
    <article
      className={`group relative rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 text-left transition-[box-shadow,opacity,filter] hover:shadow-sm ${managementDisabled ? "opacity-60 saturate-50" : ""}`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t("space.agents.viewSettings")} · ${agent.displayName}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)]/30"
      />
      <div className="pointer-events-none relative z-10 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5">
        <SpaceAvatar
          name={agent.displayName}
          avatarUrl={agent.avatarUrl}
          type="registered_agent"
          size={36}
        />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold text-[var(--ink)]">
              {agent.displayName}
            </h3>
            <span
              className={`rounded-md px-2 py-1 text-xs font-semibold ${agentStatusClass(availability)}`}
            >
              {agentStatusLabel(agent, t)}
            </span>
          </div>
          <p className="mt-1 truncate text-xs font-medium text-[var(--ink-muted)]">
            {agentCardTimeLabel(agent, t)}
          </p>
          {availability === "offline" && !agent.lastOnlineAt ? (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--ink-subtle)]">
              {t("space.agents.offlineTroubleshooting")}
            </p>
          ) : null}
        </div>
        {admin ? (
          <div className="pointer-events-auto">
            <AgentCardMenu
              agent={agent}
              busy={busy}
              disabled={revoked}
              t={t}
              onOpen={onOpen}
              onEdit={onEdit}
              onToggle={onToggle}
              onRevoke={onRevoke}
            />
          </div>
        ) : null}
      </div>

      <div className="pointer-events-none relative z-10 mt-2.5 grid gap-1.5">
        <AgentCardField
          icon={Computer}
          label={t("space.agents.localComputer")}
          value={localComputerLabel(agent, t)}
        />
        <AgentCardField
          icon={FolderOpen}
          label={t("space.agents.workspacePath")}
          value={agentWorkspacePathLabel(agent, t)}
          title={agent.workspacePath || undefined}
          mono
        />
        <AgentCardField
          icon={Target}
          label={t("space.agents.instructionLabel")}
          value={agentInstructionSummary(agent, t)}
          muted={!agent.instruction}
        />
        <AgentCardField
          icon={Activity}
          label={t("space.agents.subscriptions")}
          value={agentSubscriptionLabels(agent, t)}
          muted={agent.subscriptions.length === 0}
        />
      </div>
    </article>
  );
}

function AgentCardMenu({
  agent,
  busy,
  disabled,
  t,
  onOpen,
  onEdit,
  onToggle,
  onRevoke,
}: {
  agent: LocalRegisteredAgent;
  busy: boolean;
  disabled: boolean;
  t: ReturnType<typeof useTranslation>["t"];
  onOpen: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const actionDisabled = busy || disabled;
  const toggleLabel =
    agent.status === "disabled"
      ? t("space.agents.enable")
      : t("space.agents.disable");
  const sections: DropdownMenuSection[] = [
    {
      items: [
        {
          icon: <Eye className="h-3.5 w-3.5" />,
          label: t("space.agents.details"),
          onClick: onOpen,
        },
      ],
    },
    {
      items: [
        {
          icon: <Settings className="h-3.5 w-3.5" />,
          label: t("space.agents.edit"),
          onClick: onEdit,
          disabled: actionDisabled,
        },
        {
          icon: busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : agent.status === "disabled" ? (
            <Power className="h-3.5 w-3.5" />
          ) : (
            <PowerOff className="h-3.5 w-3.5" />
          ),
          label: toggleLabel,
          onClick: onToggle,
          disabled: actionDisabled,
        },
        {
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: t("space.agents.revoke"),
          onClick: onRevoke,
          disabled: actionDisabled,
          danger: true,
        },
      ],
    },
  ];

  return (
    <DropdownMenu
      sections={sections}
      size="md"
      minWidth={160}
      title={t("dropdown.moreActions")}
    />
  );
}

function AgentActionButtons({
  agent,
  busy,
  disabled,
  t,
  onEdit,
  onToggle,
  onRevoke,
}: {
  agent: LocalRegisteredAgent;
  busy: boolean;
  disabled: boolean;
  t: ReturnType<typeof useTranslation>["t"];
  onEdit: () => void;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const stopAndRun = (
    event: React.MouseEvent<HTMLButtonElement>,
    action: () => void,
  ) => {
    event.stopPropagation();
    action();
  };

  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        disabled={busy || disabled}
        onClick={(event) => stopAndRun(event, onEdit)}
        className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
        aria-label={t("space.agents.editAgent", { name: agent.displayName })}
        title={t("space.agents.edit")}
      >
        <Settings className="h-4 w-4" />
      </button>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={(event) => stopAndRun(event, onToggle)}
        className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-45"
        aria-label={
          agent.status === "disabled"
            ? t("space.agents.enableAgent", { name: agent.displayName })
            : t("space.agents.disableAgent", { name: agent.displayName })
        }
        title={
          agent.status === "disabled"
            ? t("space.agents.enable")
            : t("space.agents.disable")
        }
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : agent.status === "disabled" ? (
          <Power className="h-4 w-4" />
        ) : (
          <PowerOff className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={(event) => stopAndRun(event, onRevoke)}
        className="grid h-8 w-8 place-items-center rounded-lg text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-45"
        aria-label={t("space.agents.revokeAgent", { name: agent.displayName })}
        title={t("space.agents.revoke")}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </span>
  );
}

function AgentCardField({
  icon: Icon,
  label,
  value,
  title,
  mono = false,
  muted = false,
}: {
  icon: typeof Computer;
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="grid grid-cols-[14px_92px_minmax(0,1fr)] items-center gap-2 rounded-md bg-[var(--paper)]/35 px-2 py-1 text-xs leading-5">
      <Icon className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
      <span className="truncate font-normal text-[var(--ink-subtle)]">
        {label}
      </span>
      <span
        title={title ?? value}
        className={`truncate font-normal ${mono ? "font-mono" : ""} ${muted ? "text-[var(--ink-subtle)]" : "text-[var(--ink-muted)]"}`}
      >
        {value}
      </span>
    </div>
  );
}

function AgentDetailOverlay({
  agent,
  admin,
  busy,
  t,
  actions,
  avatarPresets,
  onClose,
  onEdit,
  onToggle,
  onRevoke,
}: {
  agent: LocalRegisteredAgent;
  admin: boolean;
  busy: boolean;
  t: ReturnType<typeof useTranslation>["t"];
  actions: SpaceActions;
  avatarPresets: SpaceAvatarPresetsState;
  onClose: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRevoke: () => void;
}) {
  const toast = useToast();
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const availability = registeredAgentAvailability(agent);
  useCloseLayer(() => {
    if (avatarPickerOpen || avatarBusy) return false;
    onClose();
    return true;
  }, 230);

  const selectAvatar = async (selection: AvatarPickerSelection) => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      await actions.updateRegisteredAgentAvatar(
        selection.type === "upload"
          ? { id: agent.id, avatarFilePath: selection.avatarFilePath }
          : { id: agent.id, avatarPresetId: selection.presetId },
      );
      toast.success(t("space.toasts.agentAvatarUpdated"));
      setAvatarPickerOpen(false);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <OverlayBackdrop
      onClose={avatarBusy || avatarPickerOpen ? undefined : onClose}
      className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm"
    >
      <aside className="h-full w-[min(72vw,900px)] overflow-y-auto border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl max-lg:w-[min(92vw,820px)]">
        <header className="sticky top-0 z-10 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)]/95 px-7 py-5 backdrop-blur-md">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
            <button
              type="button"
              disabled={
                !admin || busy || avatarBusy || agent.status === "revoked"
              }
              onClick={() => setAvatarPickerOpen(true)}
              className="group relative grid h-14 w-14 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-70"
              aria-label={t("space.agents.changeAvatar")}
              title={t("space.agents.changeAvatar")}
            >
              <SpaceAvatar
                name={agent.displayName}
                avatarUrl={agent.avatarUrl}
                type="registered_agent"
                size={56}
              />
              {admin && agent.status !== "revoked" && (
                <span className="absolute inset-0 grid place-items-center rounded-full bg-[var(--ink)]/45 text-[var(--paper)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  {avatarBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Camera className="h-4 w-4" />
                  )}
                </span>
              )}
            </button>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold leading-tight text-[var(--ink)]">
                  {agent.displayName}
                </h2>
                <span
                  className={`rounded-md px-2 py-1 text-xs font-semibold ${agentStatusClass(availability)}`}
                >
                  {agentStatusLabel(agent, t)}
                </span>
              </div>
              <p className="mt-1 truncate text-sm font-medium text-[var(--ink-muted)]">
                {localComputerLabel(agent, t)}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {admin && (
                <AgentActionButtons
                  agent={agent}
                  busy={busy}
                  disabled={agent.status === "revoked"}
                  t={t}
                  onEdit={onEdit}
                  onToggle={onToggle}
                  onRevoke={onRevoke}
                />
              )}
              <button
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                aria-label={t("space.detail.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <div className="px-7 py-6">
          <section className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
            <AgentSummaryBlock
              icon={Computer}
              label={t("space.agents.localComputer")}
              value={localComputerLabel(agent, t)}
            />
            <AgentSummaryBlock
              icon={Target}
              label={t("space.agents.subscriptions")}
              value={agentSubscriptionLabels(agent, t)}
              muted={agent.subscriptions.length === 0}
            />
            <AgentSummaryBlock
              icon={FolderOpen}
              label={t("space.agents.workspacePath")}
              value={agentWorkspacePathLabel(agent, t)}
              title={agent.workspacePath || undefined}
              mono
              wide
            />
            <AgentSummaryBlock
              icon={Clock}
              label={t("space.agents.lastOnline")}
              value={agentCardTimeLabel(agent, t)}
            />
          </section>

          <section className="mt-4 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-4 py-4">
            <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
              <Target className="h-4 w-4 text-[var(--ink-muted)]" />
              {t("space.agents.instructionLabel")}
            </h3>
            <p
              className={`mt-3 whitespace-pre-wrap text-sm leading-6 ${agent.instruction ? "text-[var(--ink-secondary)]" : "text-[var(--warning)]"}`}
            >
              {agentInstructionSummary(agent, t)}
            </p>
          </section>

          <section className="mt-6 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-4 py-4">
            <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
              <Computer className="h-4 w-4 text-[var(--ink-muted)]" />
              {t("space.agents.deviceInfo")}
            </h3>
            <div className="mt-3 divide-y divide-[var(--line-subtle)]">
              <AgentDetailRow
                label={t("space.agents.deviceScope")}
                value={localityLabel(agent, t)}
              />
              <AgentDetailRow
                label={t("space.agents.localComputer")}
                value={localComputerLabel(agent, t)}
              />
              <AgentDetailRow
                label={t("space.agents.platform")}
                value={optionalDetail(
                  agent.device?.platform,
                  t("space.common.unknown"),
                )}
              />
              <AgentDetailRow
                label={t("space.agents.osVersion")}
                value={optionalDetail(
                  agent.device?.osVersion,
                  t("space.common.unknown"),
                )}
              />
              <AgentDetailRow
                label={t("space.agents.appVersion")}
                value={optionalDetail(
                  agent.device?.appVersion,
                  t("space.common.unknown"),
                )}
              />
              <AgentDetailRow
                label={t("space.agents.deviceId")}
                value={optionalDetail(
                  agent.device?.deviceId ?? agent.deviceId,
                  t("space.common.unknown"),
                )}
                mono
              />
              <AgentDetailRow
                label={t("space.agents.lastOnline")}
                value={
                  formatTime(agent.lastOnlineAt ?? "") ||
                  t("space.common.notSynced")
                }
              />
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-4 py-4">
            <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
              <FolderOpen className="h-4 w-4 text-[var(--ink-muted)]" />
              {t("space.agents.workspaceInfo")}
            </h3>
            <div className="mt-3 divide-y divide-[var(--line-subtle)]">
              <AgentDetailRow
                label={t("space.agents.localAgentWorkspace")}
                value={
                  agent.workspaceLabel?.trim() ||
                  agentWorkspacePathLabel(agent, t)
                }
              />
              <AgentDetailRow
                label={t("space.agents.workspacePath")}
                value={optionalDetail(
                  agent.workspacePath,
                  t("space.agents.workspacePathUnavailable"),
                )}
                mono
              />
              <AgentDetailRow
                label={t("space.agents.localWorkspaceId")}
                value={optionalDetail(
                  agent.localWorkspaceId ?? agent.workspaceId,
                  t("space.common.unknown"),
                )}
                mono
              />
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-4 py-4">
            <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--ink)]">
              <Activity className="h-4 w-4 text-[var(--ink-muted)]" />
              {t("space.agents.dispatchSettings")}
            </h3>
            <div className="mt-3 divide-y divide-[var(--line-subtle)]">
              {agent.subscriptions.length === 0 ? (
                <AgentDetailRow
                  label={t("space.agents.subscriptions")}
                  value={t("space.agents.noSubscriptions")}
                />
              ) : (
                agent.subscriptions.map((subscription) => (
                  <AgentDetailRow
                    key={subscription.id}
                    label={subscription.goalPathLabel || subscription.goalId}
                    value={issueStateFilterLabel(t, subscription.stateFilter)}
                  />
                ))
              )}
              <AgentDetailRow
                label={t("space.agents.issueSubscriptionStrategy")}
                value={issueSubscriptionRunModeLabel(
                  t,
                  agent.issueSubscriptionRunMode,
                )}
              />
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)]/45 px-4 py-4">
            <h3 className="text-base font-semibold text-[var(--ink)]">
              {t("space.agents.registrationInfo")}
            </h3>
            <div className="mt-3 divide-y divide-[var(--line-subtle)]">
              <AgentDetailRow
                label={t("space.agents.agentId")}
                value={agent.id}
                mono
              />
              <AgentDetailRow
                label={t("space.agents.createdAt")}
                value={formatTime(agent.createdAt) || "n/a"}
              />
              <AgentDetailRow
                label={t("space.agents.updatedAt")}
                value={formatTime(agent.updatedAt) || "n/a"}
              />
            </div>
          </section>
        </div>
      </aside>
      {avatarPickerOpen && (
        <AvatarPicker
          kind="agents"
          presets={avatarPresets.agents}
          selectedPresetId={agent.avatarPresetId ?? null}
          currentAvatarUrl={agent.avatarUrl ?? null}
          loading={avatarPresets.isLoading}
          error={avatarPresets.error}
          disabled={avatarBusy}
          onLoad={() =>
            void actions.loadAvatarPresets({ maxAgeMs: 5 * 60_000 })
          }
          onSelect={(selection) => void selectAvatar(selection)}
          onClose={() => setAvatarPickerOpen(false)}
        />
      )}
    </OverlayBackdrop>
  );
}

function AgentSummaryBlock({
  icon: Icon,
  label,
  value,
  title,
  mono = false,
  muted = false,
  wide = false,
}: {
  icon: typeof Computer;
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  muted?: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-xl bg-[var(--paper)]/55 px-4 py-3 ${wide ? "col-span-2 max-md:col-span-1" : ""}`}
    >
      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <p
        title={title ?? value}
        className={`mt-2 break-words text-sm font-semibold leading-6 ${mono ? "font-mono" : ""} ${muted ? "text-[var(--ink-subtle)]" : "text-[var(--ink-secondary)]"}`}
      >
        {value}
      </p>
    </div>
  );
}

function AgentDetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid min-h-11 grid-cols-[140px_minmax(0,1fr)] items-center gap-3 py-2.5 max-sm:grid-cols-1 max-sm:gap-1">
      <span className="text-xs font-semibold text-[var(--ink-subtle)]">
        {label}
      </span>
      <span
        className={`min-w-0 break-words text-sm font-semibold text-[var(--ink-secondary)] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function IssueSubscriptionRunModeControl({
  value,
  onChange,
  disabled,
}: {
  value: SpaceIssueSubscriptionRunMode;
  onChange: (value: SpaceIssueSubscriptionRunMode) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("app");
  const normalized = normalizeIssueSubscriptionRunMode(value);
  const options: Array<{
    value: SpaceIssueSubscriptionRunMode;
    label: string;
    description: string;
  }> = [
    {
      value: "new_session",
      label: t("space.agents.issueSubscriptionNewSession"),
      description: t("space.agents.issueSubscriptionNewSessionDescription"),
    },
    {
      value: "single_session",
      label: t("space.agents.issueSubscriptionSingleSession"),
      description: t("space.agents.issueSubscriptionSingleSessionDescription"),
    },
  ];
  const active =
    options.find((option) => option.value === normalized) ?? options[0];

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-[var(--ink)]">
        {t("space.agents.issueSubscriptionStrategy")}
      </span>
      <div className="inline-flex rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-1">
        {options.map((option) => {
          const selected = option.value === normalized;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`h-8 rounded-md px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${selected ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]"}`}
              aria-pressed={selected}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">
        {active.description}
      </p>
    </div>
  );
}

function IssueSubscriptionScopeControl({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("app");
  const normalized = normalizeAgentStateFilter(value);
  const toggleState = (state: string) => {
    if (disabled) return;
    const selected = normalized.includes(state);
    const next = selected
      ? normalized.filter((item) => item !== state)
      : [...normalized, state];
    onChange(normalizeAgentStateFilter(next.length > 0 ? next : normalized));
  };

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-[var(--ink)]">
        {t("space.agents.subscriptionScope")}
      </span>
      <div className="flex flex-wrap gap-2">
        {AGENT_SUBSCRIPTION_STATE_OPTIONS.map((state) => {
          const selected = normalized.includes(state);
          return (
            <button
              key={state}
              type="button"
              disabled={disabled}
              onClick={() => toggleState(state)}
              className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? "border-[var(--accent-warm)]/35 bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]"
                  : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
              }`}
              aria-pressed={selected}
            >
              {selected ? <Check className="h-3.5 w-3.5" /> : null}
              {issueStatusLabel(state, t)}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">
        {t("space.agents.subscriptionScopeDescription")}
      </p>
    </div>
  );
}

export function RegisterAgentDialog({
  projects,
  goals,
  actions,
  onClose,
  onRegistered,
}: {
  projects: Project[];
  goals: SpaceGoal[];
  actions: SpaceActions;
  onClose: () => void;
  onRegistered: (agent: LocalRegisteredAgent) => void;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const [displayName, setDisplayName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const [workspaceId, setWorkspaceId] = useState(projects[0]?.id ?? "");
  const [goalId, setGoalId] = useState(goals[0]?.id ?? "");
  const [stateFilter, setStateFilter] = useState<string[]>(() => [
    ...DEFAULT_AGENT_STATE_FILTER,
  ]);
  const [issueSubscriptionRunMode, setIssueSubscriptionRunMode] =
    useState<SpaceIssueSubscriptionRunMode>(
      NEW_AGENT_ISSUE_SUBSCRIPTION_RUN_MODE,
    );
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const projectOptions = useMemo<SelectOption[]>(
    () =>
      projects.map((project) => ({
        value: project.id,
        label: projectLabel(project),
      })),
    [projects],
  );
  const goalOptions = useMemo<SelectOption[]>(
    () =>
      goals.map((goal) => {
        const label = goal.goalPathLabel || goal.title;
        return {
          value: goal.id,
          label,
          content: <GoalPathLabel label={label} leafLabel={goal.title} />,
        };
      }),
    [goals],
  );

  const submit = async () => {
    const project = projects.find((item) => item.id === workspaceId);
    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      setInstructionError(t("space.agents.instructionRequired"));
      instructionRef.current?.focus();
      return;
    }
    if (
      instructionLength(normalizedInstruction) > MAX_AGENT_INSTRUCTION_CHARS
    ) {
      setInstructionError(t("space.agents.instructionTooLong"));
      instructionRef.current?.focus();
      return;
    }
    setInstructionError(null);
    if (!project || !displayName.trim() || !goalId || stateFilter.length === 0)
      return;
    setBusy(true);
    try {
      const agent = await actions.registerAgent({
        displayName: displayName.trim(),
        instruction: normalizedInstruction,
        workspaceId: project.id,
        workspacePath: project.path,
        workspaceLabel: projectLabel(project),
        goalId,
        stateFilter,
        issueSubscriptionRunMode,
      });
      toast.success(t("space.toasts.agentCreated"));
      onRegistered(agent);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop
      onClose={onClose}
      className="z-[220] items-center justify-center bg-black/20 p-6 backdrop-blur-sm max-sm:p-3"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("space.agents.registerTitle")}
        className="grid max-h-[calc(100dvh-48px)] w-full max-w-[720px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl max-sm:max-h-[calc(100dvh-24px)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">
              {t("space.agents.registerTitle")}
            </h2>
            <p className="text-sm text-[var(--ink-muted)]">
              {t("space.agents.officialSpace")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">
              {t("space.agents.name")}
            </span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
              placeholder={t("space.agents.displayNamePlaceholder")}
              disabled={busy}
            />
          </label>
          <AgentInstructionField
            value={instruction}
            onChange={(value) => {
              setInstruction(value);
              if (instructionError) setInstructionError(null);
            }}
            error={instructionError}
            inputRef={instructionRef}
            disabled={busy}
          />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">
              {t("space.agents.localAgentWorkspace")}
            </span>
            <CustomSelect
              value={workspaceId}
              options={projectOptions}
              onChange={setWorkspaceId}
              disabled={busy}
              size="md"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">
              {t("space.agents.subscriptionTarget")}
            </span>
            <CustomSelect
              value={goalId}
              options={goalOptions}
              onChange={setGoalId}
              disabled={busy}
              size="md"
            />
          </label>
          <IssueSubscriptionScopeControl
            value={stateFilter}
            onChange={setStateFilter}
            disabled={busy}
          />
          <IssueSubscriptionRunModeControl
            value={issueSubscriptionRunMode}
            onChange={setIssueSubscriptionRunMode}
            disabled={busy}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg px-4 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            {t("space.common.cancel")}
          </button>
          <button
            type="button"
            disabled={
              busy ||
              !workspaceId ||
              !displayName.trim() ||
              !goalId ||
              stateFilter.length === 0
            }
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
            {t("space.agents.register")}
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
