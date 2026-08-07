// DispatchTaskDialog — Full-featured modal for creating a Task.
// Two invocation paths, single surface:
//   • `thought` present → "派发为任务": prefills name/body from the thought and
//     preserves its existing tags as provenance without exposing extra form chrome,
//     links `sourceThoughtId` so the thought card knows about the derived task.
//   • `thought` absent  → "新建任务": starts from a blank slate. Used by the
//     Launcher recent-tasks "+" button and the Task Center overlay header.
//
// v0.2.4 chrome refactor: shares PanelHeader / FormSection / PanelFooter /
// Toggle with TaskEditPanel + TaskDetailOverlay. Width matched to the
// detail overlay (780px) so create → edit feels continuous. Notification
// UI now reuses the shared NotificationConfigEditor instead of an
// inline copy that drifted on toggle dimensions and label wording.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Bell,
  ChevronDown,
  ChevronRight,
  Clock,
  Flag,
  Zap,
} from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useConfig } from '@/hooks/useConfig';
import { useTaskCenterData } from '@/hooks/useTaskCenterData';
import { useToast } from '@/components/Toast';
import { isProjectActiveForUser } from '@/config/types';
import { taskCreateDirect, taskRun, taskWriteDoc } from '@/api/taskCenter';
import NotificationConfigEditor from '@/components/task-center/NotificationConfigEditor';
import { splitWithTagHighlights } from '@/utils/parseThoughtTags';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import type { Thought } from '@/../shared/types/thought';
import type {
  EndConditions,
  NotificationConfig,
  Task,
  TaskExecutionMode,
  TaskRunMode,
  TaskTrigger,
} from '@/../shared/types/task';
import type { RuntimeConfig, RuntimeType } from '@/../shared/types/runtime';
import { ExecutionModeEditor } from './editors/ExecutionModeEditor';
import { EndConditionsEditor, type EndConditionMode } from './editors/EndConditionsEditor';
import { INPUT_CLS, toLocalDateTimeString } from './editors/controls';
import { TaskAdvancedConfigEditor } from './editors/TaskAdvancedConfigEditor';
import { TriggerEditor } from './editors/TriggerEditor';
import { projectTaskExecutionOverrides } from './taskProviderProjection';
import {
  FormSection,
  PanelFooter,
  PanelHeader,
  SECTION_DIVIDER,
  SECTION_GAP,
  usePanelKeys,
} from './editors/PanelChrome';
import { extractErrorMessage } from './errors';

// The v0.1.69 UI no longer exposes per-event subscription; every new task
// gets the standard three-event set (done / blocked / endCondition) which
// covers virtually all observed use cases. Backend contract unchanged —
// `events` is still carried on the NotificationConfig payload.
const DEFAULT_EVENTS: NonNullable<NotificationConfig['events']> = [
  'done',
  'blocked',
  'endCondition',
];

interface Props {
  /** When provided, the task is derived from this thought; otherwise the dialog
   *  starts blank and `sourceThoughtId` is omitted. */
  thought?: Thought;
  /** Optional workspace hint for the 'new' flow (e.g. Launcher selection). */
  defaultWorkspacePath?: string;
  /** Canonical materialized Session from the Chat tab that opened Task Center. */
  currentSessionId?: string | null;
  onClose: () => void;
  onDispatched: (task: Task) => void;
}

export function DispatchTaskDialog({
  thought,
  defaultWorkspacePath,
  currentSessionId,
  onClose,
  onDispatched,
}: Props) {
  const isFromThought = !!thought;
  const { t } = useTranslation('task');
  const toast = useToast();
  const { projects, providers } = useConfig();
  const { sessions } = useTaskCenterData({ isActive: true });
  useCloseLayer(() => {
    onClose();
    return true;
  }, 200);

  const visibleProjects = useMemo(
    () => projects.filter(isProjectActiveForUser),
    [projects],
  );

  const defaultProject = useMemo(() => {
    if (visibleProjects.length === 0) return null;
    // Explicit hint wins (e.g. Launcher passed the user's selected workspace).
    if (defaultWorkspacePath) {
      const explicit = visibleProjects.find((p) => workspacePathsEqual(p.path, defaultWorkspacePath));
      if (explicit) return explicit;
    }
    // PRD §8.4 — match any of the thought's tags to a workspace name.
    if (thought) {
      const lowerTags = thought.tags.map((t) => t.toLowerCase());
      const tagged = visibleProjects.find((p) =>
        lowerTags.includes(p.name.toLowerCase()),
      );
      if (tagged) return tagged;
    }
    return visibleProjects[0];
  }, [thought, visibleProjects, defaultWorkspacePath]);

  const defaultName = useMemo(
    () => (thought ? deriveTaskName(thought.content) : ''),
    [thought],
  );

  // Form state. v0.1.69 scope is AI execution only — `executor` is pinned to
  // `'agent'`; the user-as-todo variant is a future extension.
  const [name, setName] = useState(defaultName);
  const [workspacePath, setWorkspacePath] = useState<string>(
    defaultProject?.path ?? '',
  );
  const [executionMode, setExecutionMode] = useState<TaskExecutionMode>('once');
  const [runMode, setRunMode] = useState<TaskRunMode>('new-session');
  const [preselectedSessionId, setPreselectedSessionId] = useState('');
  const [trigger, setTrigger] = useState<TaskTrigger>({
    source: { type: 'time' },
    detector: { type: 'always' },
  });
  const [triggerValid, setTriggerValid] = useState(true);
  const [taskMd, setTaskMd] = useState(thought?.content ?? '');
  const [verifyMd, setVerifyMd] = useState('');
  const [verifyExpanded, setVerifyExpanded] = useState(false);

  // Schedule-specific state (mirrors cron TaskCreateModal fields)
  const [atDateTime, setAtDateTime] = useState(() =>
    toLocalDateTimeString(new Date(Date.now() + 3600_000)),
  );
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [cronExpression, setCronExpression] = useState('');
  const [cronTimezone, setCronTimezone] = useState('');

  // End conditions
  const [endConditionMode, setEndConditionMode] = useState<EndConditionMode>('forever');
  const [deadline, setDeadline] = useState('');
  const [maxExecutions, setMaxExecutions] = useState('');
  const [aiCanExit, setAiCanExit] = useState(true);

  // Notification — uses the shared editor so dispatch / edit stay aligned.
  const [notification, setNotification] = useState<NotificationConfig>({
    desktop: true,
    events: DEFAULT_EVENTS,
  });

  // Advanced overrides (PRD 0.2.4 §需求 4 / PRD 0.2.9) — undefined means "follow Agent".
  const [advRuntime, setAdvRuntime] = useState<RuntimeType | undefined>(undefined);
  const [advProviderId, setAdvProviderId] = useState<string | undefined>(undefined);
  const [advModel, setAdvModel] = useState<string | undefined>(undefined);
  const [advRuntimeConfig, setAdvRuntimeConfig] = useState<RuntimeConfig | undefined>(undefined);
  const [advPermissionMode, setAdvPermissionMode] = useState<string | undefined>(undefined);
  const [advMcpEnabledServers, setAdvMcpEnabledServers] = useState<string[] | undefined>(undefined);

  const [busy, setBusy] = useState(false);

  // Keep runMode aligned with PRD §9.2 defaults when the user flips modes.
  useEffect(() => {
    if (executionMode === 'loop') setRunMode('single-session');
    else if (executionMode === 'recurring') setRunMode('new-session');
  }, [executionMode]);

  const workspace = useMemo(
    () => visibleProjects.find((p) => workspacePathsEqual(p.path, workspacePath)) ?? null,
    [workspacePath, visibleProjects],
  );

  const projectOptions = useMemo(
    () =>
      visibleProjects.map((p) => ({
        value: p.path,
        label: p.displayName || p.name || p.path.split('/').pop() || p.path,
        icon: <WorkspaceIcon icon={p.icon} size={16} />,
      })),
    [visibleProjects],
  );
  const sessionOptions = useMemo(
    () => {
      const available = sessions.filter(
        (session) => workspace && workspacePathsEqual(session.agentDir, workspace.path),
      );
      return available
        .sort((left, right) => {
          if (left.id === currentSessionId) return -1;
          if (right.id === currentSessionId) return 1;
          return 0;
        })
        .map((session) => ({
          value: session.id,
          label: session.id === currentSessionId
            ? t('trigger.sessionCurrent', { title: session.title || session.id })
            : t('trigger.sessionOther', { title: session.title || session.id }),
        }));
    },
    [currentSessionId, sessions, t, workspace],
  );

  const isScheduled = executionMode === 'scheduled';
  const isRecurring = executionMode === 'recurring';
  const isLoop = executionMode === 'loop';
  const isOnce = executionMode === 'once';
  const showEndConditions = isRecurring || isLoop;

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!name.trim()) errs.push(t('dispatch.validation.nameRequired'));
    if (!workspace) errs.push(t('dispatch.validation.workspaceRequired'));
    if (!taskMd.trim()) errs.push(t('dispatch.validation.taskMdRequired'));
    if (!triggerValid) errs.push(t('trigger.validation.invalid'));
    if (
      runMode === 'single-session'
      && !sessionOptions.some((option) => option.value === preselectedSessionId)
    ) {
      errs.push(t('trigger.validation.sessionRequired'));
    }
    if (isScheduled) {
      const ts = Date.parse(atDateTime);
      if (Number.isNaN(ts) || ts <= Date.now()) errs.push(t('dispatch.validation.futureTimeRequired'));
    }
    if (isRecurring && intervalMinutes < 5) errs.push(t('dispatch.validation.intervalTooShort'));
    if (showEndConditions && endConditionMode === 'conditional' && !deadline && !maxExecutions && !aiCanExit) {
      errs.push(t('dispatch.validation.endConditionRequired'));
    }
    return errs;
  }, [
    t,
    name,
    workspace,
    taskMd,
    triggerValid,
    runMode,
    preselectedSessionId,
    sessionOptions,
    isScheduled,
    atDateTime,
    isRecurring,
    intervalMinutes,
    showEndConditions,
    endConditionMode,
    deadline,
    maxExecutions,
    aiCanExit,
  ]);

  const buildEndConditions = useCallback((): EndConditions | undefined => {
    if (!showEndConditions) return undefined;
    if (endConditionMode === 'forever') return { aiCanExit };
    const out: EndConditions = { aiCanExit };
    if (deadline) {
      const ts = Date.parse(deadline);
      if (!Number.isNaN(ts)) out.deadline = ts;
    }
    if (maxExecutions) {
      const n = parseInt(maxExecutions, 10);
      if (!Number.isNaN(n) && n > 0) out.maxExecutions = n;
    }
    return out;
  }, [showEndConditions, endConditionMode, aiCanExit, deadline, maxExecutions]);

  const handleSubmit = useCallback(async () => {
    if (errors.length > 0 || busy || !workspace) return;
    setBusy(true);
    try {
      // v0.1.69 — scheduling detail lives on dedicated Task fields so the
      // backend no longer has to deduce "when to fire" from
      // endConditions.deadline (which means "when to stop running").
      const ec = buildEndConditions();
      const dispatchAt = isScheduled
        ? (() => {
            const ts = Date.parse(atDateTime);
            return Number.isNaN(ts) ? undefined : ts;
          })()
        : undefined;
      const advancedCron = cronExpression.trim();
      const executionOverrides = projectTaskExecutionOverrides({
        providers,
        runtime: advRuntime,
        providerId: advProviderId,
        model: advModel,
        runtimeConfig: advRuntimeConfig,
      });
      const task = await taskCreateDirect({
        name: name.trim(),
        executor: 'agent',
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        taskMdContent: taskMd,
        executionMode,
        runMode,
        preselectedSessionId: runMode === 'single-session' ? preselectedSessionId : undefined,
        trigger: trigger.detector.type === 'command' ? trigger : undefined,
        endConditions: ec,
        dispatchAt,
        intervalMinutes: isRecurring && !advancedCron ? intervalMinutes : undefined,
        cronExpression: isRecurring && advancedCron ? advancedCron : undefined,
        cronTimezone: isRecurring && advancedCron ? cronTimezone || undefined : undefined,
        // Advanced overrides — `undefined` is forwarded as "follow Agent".
        // PRD 0.2.9 — providerId / model are paired (validated server-side),
        // and external-runtime model lives on runtimeConfig.model.
        runtime: executionOverrides.runtime,
        providerId: executionOverrides.providerId,
        model: executionOverrides.model,
        // RuntimeConfig (renderer/runtime.ts) and RuntimeConfigSnapshot (shared
        // task DTO) are structurally compatible; the latter just adds an
        // open-ended `[key: string]: unknown` index signature for
        // forward-compat. Cast here to avoid leaking that index sig into
        // the renderer's RuntimeConfig type.
        runtimeConfig: executionOverrides.runtimeConfig as Record<string, unknown> | undefined,
        permissionMode: advPermissionMode,
        mcpEnabledServers: advMcpEnabledServers,
        sourceThoughtId: thought?.id,
        tags: thought?.tags ?? [],
        notification,
      });
      // verify.md is a separate `write_doc` call. We do this before the
      // dispatch run so the agent's verifying phase finds the file in
      // place. A failure here is non-fatal — surface a toast but still
      // hand the task back to the caller.
      if (verifyMd.trim()) {
        try {
          await taskWriteDoc(task.id, 'verify', verifyMd);
        } catch (e) {
          toast.error(t('dispatch.toast.verifyWriteFailed', { message: extractErrorMessage(e) }));
        }
      }
      // PRD §8.2: `once` dispatches should fire immediately — the user
      // just asked to "立即执行", they shouldn't also have to click a
      // play button in the right panel. Other modes wait for their
      // schedule / recurrence to hit naturally.
      if (isOnce) {
        try {
          await taskRun(task.id);
          toast.success(t('dispatch.toast.dispatched', { name: task.name }));
        } catch (e) {
          toast.error(t('dispatch.toast.startFailed', { message: extractErrorMessage(e) }));
        }
      } else {
        toast.success(t('dispatch.toast.created', { name: task.name }));
      }
      onDispatched(task);
    } catch (e) {
      toast.error(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [
    errors.length,
    busy,
    workspace,
    buildEndConditions,
    isScheduled,
    atDateTime,
    isRecurring,
    intervalMinutes,
    cronExpression,
    cronTimezone,
    name,
    taskMd,
    verifyMd,
    executionMode,
    isOnce,
    runMode,
    preselectedSessionId,
    trigger,
    thought,
    notification,
    providers,
    toast,
    onDispatched,
    advRuntime,
    advProviderId,
    advModel,
    advRuntimeConfig,
    advPermissionMode,
    advMcpEnabledServers,
    t,
  ]);

  // Esc closes, Cmd/Ctrl+Enter submits. Disabled flag mirrors the primary
  // button so a half-filled form can't be submitted via shortcut.
  usePanelKeys({
    onClose,
    onSubmit: handleSubmit,
    disabled: errors.length > 0 || busy,
  });

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div className="flex max-h-[85vh] w-[min(780px,92vw)] flex-col rounded-[var(--radius-2xl)] bg-[var(--paper-elevated)] shadow-2xl">
        <PanelHeader
          icon={Zap}
          title={isFromThought ? t('dispatch.titleFromThought') : t('dispatch.titleNew')}
          subtitle={
            isFromThought
              ? t('dispatch.subtitleFromThought')
              : t('dispatch.subtitleNew')
          }
          onClose={onClose}
          closeTitle={t('dispatch.closeEsc')}
        />

        {/* Body — generous breathing room per design review */}
        <div className={`flex-1 overflow-y-auto px-6 py-6 ${SECTION_GAP}`}>
          <div className="space-y-5">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-[var(--ink-secondary)]">
                {t('dispatch.name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_NAME_LEN}
                placeholder={t('dispatch.namePlaceholder')}
                className={INPUT_CLS}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-[var(--ink-secondary)]">
                {t('dispatch.taskMd')}
              </label>
              <textarea
                value={taskMd}
                onChange={(e) => setTaskMd(e.target.value)}
                rows={12}
                placeholder={t('dispatch.taskMdPlaceholder')}
                className={`${INPUT_CLS} resize-y font-mono text-sm`}
              />
            </div>

            {/* verify.md — folded by default. The dispatch flow used to
                force users to "create then immediately edit to add a
                verification list", which is two steps for what should
                be one. Showing it here matches the edit panel's
                symmetric task.md / verify.md pair. */}
            <div className="rounded-[var(--radius-lg)] border border-[var(--line-subtle)] bg-[var(--paper)]">
              <button
                type="button"
                onClick={() => setVerifyExpanded((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
              >
                {verifyExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {t('dispatch.verifyTitle')}
                <span className="text-xs font-normal text-[var(--ink-muted)]/80">
                  {t('dispatch.verifyHint')}
                </span>
              </button>
              {verifyExpanded && (
                <div className="border-t border-[var(--line-subtle)] p-3">
                  <textarea
                    value={verifyMd}
                    onChange={(e) => setVerifyMd(e.target.value)}
                    rows={6}
                    placeholder={t('dispatch.verifyPlaceholder')}
                    className={`${INPUT_CLS} resize-y font-mono text-sm`}
                  />
                  <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                    {t('dispatch.verifyDescription')}
                  </p>
                </div>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-[var(--ink-secondary)]">
                {t('dispatch.workspace')}
              </label>
              <CustomSelect
                value={workspacePath}
                options={projectOptions}
                onChange={setWorkspacePath}
                placeholder={t('dispatch.workspacePlaceholder')}
                size="md"
              />
              <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                {t('dispatch.workspaceHint')}
              </p>
            </div>

            {/* 高级配置 — runtime / provider / model / permission / MCP overrides */}
            <TaskAdvancedConfigEditor
              workspacePath={workspace?.path}
              runtime={advRuntime}
              setRuntime={setAdvRuntime}
              providerId={advProviderId}
              setProviderId={setAdvProviderId}
              model={advModel}
              setModel={setAdvModel}
              runtimeConfig={advRuntimeConfig}
              setRuntimeConfig={setAdvRuntimeConfig}
              permissionMode={advPermissionMode}
              setPermissionMode={setAdvPermissionMode}
              mcpEnabledServers={advMcpEnabledServers}
              setMcpEnabledServers={setAdvMcpEnabledServers}
            />

          </div>

          <div className={SECTION_DIVIDER} />

          {/* 执行模式 */}
          <FormSection icon={Clock} title={t('dispatch.sectionExecution')}>
            <ExecutionModeEditor
              executionMode={executionMode}
              setExecutionMode={setExecutionMode}
              runMode={runMode}
              setRunMode={(next) => {
                setRunMode(next);
                if (next === 'single-session' && !preselectedSessionId) {
                  const current = sessionOptions.find((option) => option.value === currentSessionId);
                  setPreselectedSessionId(current?.value ?? '');
                }
              }}
              atDateTime={atDateTime}
              setAtDateTime={setAtDateTime}
              intervalMinutes={intervalMinutes}
              setIntervalMinutes={setIntervalMinutes}
              cronExpression={cronExpression}
              setCronExpression={setCronExpression}
              cronTimezone={cronTimezone}
              setCronTimezone={setCronTimezone}
            />
            {runMode === 'single-session' && !isLoop && (
              <div className="mt-5">
                <label className="mb-2 block text-sm font-medium text-[var(--ink-secondary)]">
                  {t('trigger.targetSession')}
                </label>
                <CustomSelect
                  value={preselectedSessionId}
                  options={sessionOptions}
                  onChange={setPreselectedSessionId}
                  placeholder={t('trigger.targetSessionPlaceholder')}
                  size="md"
                />
                <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                  {t('trigger.targetSessionHint')}
                </p>
              </div>
            )}
          </FormSection>

          <div className={SECTION_DIVIDER} />

          <FormSection icon={Activity} title={t('trigger.sectionTitle')}>
            <TriggerEditor
              value={trigger}
              workspacePath={workspace?.path ?? ''}
              onChange={setTrigger}
              onValidityChange={setTriggerValid}
            />
          </FormSection>

          {showEndConditions && (
            <>
              <div className={SECTION_DIVIDER} />
              <FormSection icon={Flag} title={t('dispatch.sectionEndConditions')}>
                <EndConditionsEditor
                  mode={endConditionMode}
                  setMode={setEndConditionMode}
                  deadline={deadline}
                  setDeadline={setDeadline}
                  maxExecutions={maxExecutions}
                  setMaxExecutions={setMaxExecutions}
                  aiCanExit={aiCanExit}
                  setAiCanExit={setAiCanExit}
                />
              </FormSection>
            </>
          )}

          <div className={SECTION_DIVIDER} />

          {/* 通知 */}
          <FormSection icon={Bell} title={t('dispatch.sectionNotifications')}>
            <NotificationConfigEditor
              value={notification}
              onChange={setNotification}
              workspacePath={workspace?.path}
            />
          </FormSection>
        </div>

        <PanelFooter
          error={errors[0] ?? null}
          onCancel={onClose}
          onSubmit={() => void handleSubmit()}
          busy={busy}
          disabled={errors.length > 0}
          submitLabel={
            busy
              ? isFromThought ? t('dispatch.submitDispatching') : t('dispatch.submitCreating')
              : isFromThought ? t('dispatch.submitDispatch') : t('dispatch.submitCreate')
          }
        />
      </div>
    </OverlayBackdrop>
  );
}

// Derive a concise task name from thought body:
//   1. walk lines in order; pick the first one whose stripped form (tags
//      removed via the shared parser, so boundary rules match Rust) is
//      non-empty. This handles thoughts whose first line is a pure
//      `#tag1 #tag2` header — we scroll past it to the real title line.
//   2. if every line is tag-only (the user really did save "#idea"
//      alone), fall back to the first raw line so the field isn't blank.
//   3. clamp to MAX_NAME_LEN codepoints (not UTF-16 code units) so we
//      can't slice mid-surrogate on emoji / astral-plane chars.
const MAX_NAME_LEN = 40;

function stripTagRuns(line: string): string {
  return splitWithTagHighlights(line)
    .filter((seg) => seg.type !== 'tag')
    .map((seg) => seg.value)
    .join('')
    .trim();
}

function deriveTaskName(content: string): string {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  let candidate = '';
  for (const line of lines) {
    const stripped = stripTagRuns(line);
    if (stripped) {
      candidate = stripped;
      break;
    }
  }
  // Pure-tag thought (e.g. "#idea") — keep the tags visible rather than
  // handing back an empty string.
  if (!candidate && lines.length > 0) candidate = lines[0];
  const cps = Array.from(candidate);
  if (cps.length <= MAX_NAME_LEN) return candidate;
  return cps.slice(0, MAX_NAME_LEN - 1).join('') + '…';
}

export default DispatchTaskDialog;
