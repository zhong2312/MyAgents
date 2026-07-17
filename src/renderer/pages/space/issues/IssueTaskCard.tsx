import { useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  SpaceGoal,
  SpaceIssue,
  SpaceIssueGoalReference,
  SpaceRegisteredAgent,
  SpaceSession,
} from '@/api/spaceCloud';
import { SpaceIdentityLine } from '@/pages/space/SpaceAvatar';
import { GoalPathLabel } from '@/pages/space/GoalPathLabel';
import { issueStatusLabel } from '@/pages/space/spaceHelpers';
import { statusPillClass, statusTextClass } from '@/pages/space/spaceUi';
import { Popover } from '@/components/ui/Popover';
import { IssueAssigneePicker } from './IssueAssigneePicker';

type StatusOption = { value: string; label: string; kind: 'set-status' | 'close-own' };

export function IssueTaskCard({
  issue,
  goalReference,
  goals,
  session,
  agents,
  statusOptions,
  statusBusy,
  goalBusy,
  onChangeStatus,
  onChangeGoal,
  onAssign,
  onCancelAssignee,
}: {
  issue: SpaceIssue;
  goalReference?: SpaceIssueGoalReference | null;
  goals: SpaceGoal[];
  session: SpaceSession;
  agents: SpaceRegisteredAgent[];
  statusOptions: StatusOption[];
  statusBusy: boolean;
  goalBusy: boolean;
  onChangeStatus: (option: StatusOption) => Promise<void>;
  onChangeGoal: (goalId: string | null) => Promise<void>;
  onAssign: (assignee: { type: 'user' | 'registered_agent'; id: string }) => Promise<void>;
  onCancelAssignee: () => Promise<void>;
}) {
  const { t } = useTranslation('app');
  const goalAnchorRef = useRef<HTMLButtonElement | null>(null);
  const statusAnchorRef = useRef<HTMLButtonElement | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const admin = session.membership.role === 'owner' || session.membership.role === 'admin';
  const creator = issue.creator ?? issue.author ?? null;
  const selectedGoal = issue.goalId
    ? goals.find((goal) => goal.id === issue.goalId)
    : null;

  const goalLabel = goalReference?.goalPathLabel
    || goalReference?.goalTitle
    || issue.goalPathLabel
    || t('space.detail.noGoal');
  const goalLeafLabel = goalReference?.goalTitle || selectedGoal?.title;

  return (
    <section
      aria-label={t('space.detail.taskCard')}
      className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4 py-3 shadow-sm max-sm:grid-cols-1"
    >
      <TaskFact label={t('space.detail.creator')}>
        <SpaceIdentityLine
          name={creator?.name ?? creator?.id ?? '—'}
          avatarUrl={creator?.avatarUrl}
          type={creator?.type ?? issue.createdByType ?? 'user'}
          avatarSize={20}
          nameClassName="font-medium text-[var(--ink)]"
          showAgentTag
          agentOwnerName={creator?.owner?.name}
        />
      </TaskFact>

      <TaskFact label={t('space.detail.goal')}>
        <span className="inline-flex min-w-0">
          <button
            ref={goalAnchorRef}
            type="button"
            disabled={!admin || goalBusy}
            onClick={() => setGoalOpen((value) => !value)}
            className="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] active:scale-[0.98] disabled:pointer-events-none"
          >
            {goalBusy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
            <GoalPathLabel
              label={goalLabel}
              leafLabel={goalLeafLabel || goalLabel}
            />
            {admin && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />}
          </button>
          <Popover
            open={goalOpen && admin}
            onClose={() => setGoalOpen(false)}
            anchorRef={goalAnchorRef}
            offset={8}
            className="w-72 rounded-xl p-1.5"
          >
            <div className="max-h-64 overflow-y-auto">
              <button
                type="button"
                disabled={goalBusy}
                onClick={() => {
                  if (!issue.goalId) return setGoalOpen(false);
                  void onChangeGoal(null).then(() => setGoalOpen(false));
                }}
                className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
              >
                <span className="truncate">{t('space.detail.noGoal')}</span>
                {!issue.goalId && <Check className="h-4 w-4 shrink-0 text-[var(--accent-cool)]" />}
              </button>
              {goals.filter((goal) => !goal.archivedAt).map((goal) => {
                const selected = goal.id === issue.goalId;
                return (
                  <button
                    key={goal.id}
                    type="button"
                    disabled={goalBusy}
                    onClick={() => {
                      if (selected) return setGoalOpen(false);
                      void onChangeGoal(goal.id).then(() => setGoalOpen(false));
                    }}
                    className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
                  >
                    <GoalPathLabel
                      label={goal.goalPathLabel || goal.path || goal.title}
                      leafLabel={goal.title}
                    />
                    {selected && <Check className="h-4 w-4 shrink-0 text-[var(--accent-cool)]" />}
                  </button>
                );
              })}
            </div>
          </Popover>
        </span>
      </TaskFact>

      <TaskFact label={t('space.detail.issueState')}>
        <span className="inline-flex">
          <button
            ref={statusAnchorRef}
            type="button"
            disabled={statusOptions.length === 0 || statusBusy}
            onClick={() => setStatusOpen((value) => !value)}
            className={`inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors active:scale-[0.98] ${statusPillClass(issue.state)} disabled:pointer-events-none`}
          >
            {statusBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {issueStatusLabel(issue.state, t)}
            {statusOptions.length > 0 && <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <Popover
            open={statusOpen && statusOptions.length > 0}
            onClose={() => setStatusOpen(false)}
            anchorRef={statusAnchorRef}
            offset={8}
            className="w-48 rounded-xl p-1.5"
          >
              {statusOptions.map((option) => {
                const selected = issue.state === option.value;
                return (
                  <button
                    key={`${option.kind}:${option.value}`}
                    type="button"
                    onClick={() => {
                      if (selected) return setStatusOpen(false);
                      void onChangeStatus(option).then(() => setStatusOpen(false));
                    }}
                    className="flex h-9 w-full items-center justify-between gap-3 rounded-lg px-2.5 text-left text-sm font-semibold transition-colors hover:bg-[var(--paper-inset)]"
                  >
                    <span className={statusTextClass(option.value)}>{option.label}</span>
                    {selected && <Check className={`h-4 w-4 ${statusTextClass(option.value)}`} />}
                  </button>
                );
              })}
          </Popover>
        </span>
      </TaskFact>

      <TaskFact label={t('space.detail.assignee')}>
        <IssueAssigneePicker
          session={session}
          assignee={issue.assignee}
          agents={agents}
          humanOnly={issue.humanOnly}
          onSelect={onAssign}
          onCancel={onCancelAssignee}
        />
      </TaskFact>
    </section>
  );
}

function TaskFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-xs font-medium text-[var(--ink-subtle)]">{label}</span>
      <span className="min-w-0 text-sm text-[var(--ink)]">{children}</span>
    </div>
  );
}
