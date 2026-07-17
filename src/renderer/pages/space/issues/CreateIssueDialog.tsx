import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, Loader2, Paperclip, Target, X } from 'lucide-react';

import { spaceErrorMessage, type SpaceGoal, type SpaceIdentitySummary, type SpaceRegisteredAgent, type SpaceSession } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { GoalPathLabel } from '@/pages/space/GoalPathLabel';
import type { IssueQueryParams } from '@/pages/space/spaceHelpers';
import { SPACE_VISIBLE_REFRESH_TTL_MS, type SpaceActions } from '@/pages/space/spaceStore';
import { IssueAttachmentDraftList } from './IssueAttachmentDraftList';
import { IssueAssigneePicker, type AssigneeChoice } from './IssueAssigneePicker';
import { useSpaceAttachmentDrafts } from './useSpaceAttachmentDrafts';

export function CreateIssueDialog({
  goals,
  actions,
  issueQuery,
  session,
  registeredAgents,
  onClose,
  onCreated,
}: {
  goals: SpaceGoal[];
  actions: SpaceActions;
  issueQuery: IssueQueryParams;
  session: SpaceSession;
  registeredAgents: SpaceRegisteredAgent[];
  onClose: () => void;
  onCreated: (keepOpen: boolean) => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [goalId, setGoalId] = useState(issueQuery.goalId ?? '');
  const [assignee, setAssignee] = useState<SpaceIdentitySummary | null>(null);
  const attachmentDrafts = useSpaceAttachmentDrafts(() => toast.error(t('space.createIssue.attachmentLimit')));
  const [continuous, setContinuous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  useEffect(() => {
    window.setTimeout(() => titleInputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (goalId && !goals.some((item) => item.id === goalId)) {
      setGoalId('');
    }
  }, [goalId, goals]);

  const goalOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: '',
        label: t('space.createIssue.unselectedGoal'),
        content: (
          <GoalPathLabel
            label={t('space.createIssue.unselectedGoal')}
            leafLabel={t('space.createIssue.unselectedGoal')}
          />
        ),
      },
      ...goals.map((item) => {
        const label = item.goalPathLabel || item.title;
        return {
          value: item.id,
          label,
          content: <GoalPathLabel label={label} leafLabel={item.title} />,
        };
      }),
    ],
    [goals, t],
  );

  const pickFiles = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: t('space.createIssue.pickAttachmentsTitle') });
      const next = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (next.length > 0) await attachmentDrafts.addPaths(next);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const submit = async () => {
    if (submittingRef.current || attachmentDrafts.pending) return;
    if (!title.trim() || !body.trim()) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await actions.createIssue({
        title: title.trim(),
        body: body.trim(),
        goalId: goalId || null,
        assignee: assignee?.type === 'user' || assignee?.type === 'registered_agent'
          ? { type: assignee.type, id: assignee.id }
          : null,
        filePaths: attachmentDrafts.filePaths,
      });
      toast.success(
        attachmentDrafts.filePaths.length > 0
          ? t('space.toasts.issueCreatedWithAttachments', { count: attachmentDrafts.filePaths.length })
          : t('space.toasts.issueCreated'),
      );
      await actions.refreshIssues(issueQuery, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, force: true, silent: true });
      if (continuous) {
        setTitle('');
        setBody('');
        attachmentDrafts.clear();
        setAssignee(null);
        window.setTimeout(() => titleInputRef.current?.focus(), 0);
        onCreated(true);
      } else {
        onCreated(false);
      }
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/30 p-8 backdrop-blur-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="grid h-[min(660px,calc(100vh-112px))] min-h-[500px] w-[min(980px,calc(100vw-160px))] max-w-full grid-rows-[auto_minmax(0,1fr)_auto] rounded-[var(--radius-2xl)] border border-[var(--line)] bg-[var(--paper-elevated)]/95 px-5 py-4 shadow-xl"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="flex min-h-[34px] items-center gap-2.5 text-base font-medium text-[var(--ink-muted)]">
            <span className="grid h-6 w-6 place-items-center rounded-lg border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <Cloud className="h-3.5 w-3.5" />
            </span>
            <span>{t('space.createIssue.community')}</span>
            <span>›</span>
            <strong className="font-semibold text-[var(--ink)]">{t('space.createIssue.title')}</strong>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={t('space.createIssue.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-2 pb-4 pt-4">
          <input
            ref={titleInputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full border-0 bg-transparent text-2xl font-semibold leading-snug text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]/60"
            placeholder={t('space.createIssue.titlePlaceholder')}
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="h-full min-h-0 w-full resize-none border-0 bg-transparent p-0 text-base leading-7 text-[var(--ink-secondary)] outline-none placeholder:text-[var(--ink-muted)]/60"
            placeholder={t('space.createIssue.bodyPlaceholder')}
          />
          <IssueAttachmentDraftList
            drafts={attachmentDrafts.drafts}
            onRemove={attachmentDrafts.remove}
            removeLabel={(name) => t('space.createIssue.removeFile', { name })}
            className="border-y border-[var(--line-subtle)] bg-[var(--paper-inset)]/35 px-2 py-1"
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 max-lg:grid-cols-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={submitting || attachmentDrafts.pending}
              onClick={() => void pickFiles()}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 text-sm font-semibold text-[var(--ink-muted)] shadow-sm transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
              aria-label={t('space.createIssue.addAttachment')}
            >
              <Paperclip className="h-4 w-4" />
              {t('space.createIssue.attachment')}
            </button>
            <span className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-3 text-sm font-medium text-[var(--ink-muted)] shadow-sm">
              <Target className="h-4 w-4" />
              <span className="shrink-0 text-xs font-semibold uppercase text-[var(--ink-muted)]/70">
                {t('space.createIssue.targetGoal')}
              </span>
              <CustomSelect value={goalId} options={goalOptions} onChange={setGoalId} compact className="w-56 [&>button]:border-0 [&>button]:bg-transparent [&>button]:p-0 [&>button]:shadow-none" />
            </span>
            <span className="inline-flex min-h-10 items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-2.5 text-sm shadow-sm">
              <span className="pl-1 text-xs font-semibold uppercase text-[var(--ink-muted)]/70">{t('space.detail.assignee')}</span>
              <IssueAssigneePicker
                session={session}
                assignee={assignee}
                agents={registeredAgents}
                cancelMode="selection"
                onSelect={async (choice: AssigneeChoice) => {
                  setAssignee({
                    id: choice.id,
                    type: choice.type,
                    name: choice.name,
                    avatarUrl: choice.avatarUrl,
                  });
                }}
                onCancel={async () => setAssignee(null)}
              />
            </span>
          </div>
          <div className="flex items-center gap-3.5 pb-0.5">
            <button
              type="button"
              aria-pressed={continuous}
              onClick={() => setContinuous((value) => !value)}
              className="inline-flex items-center gap-2 rounded-full px-1 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              <span className={`h-6 w-11 rounded-full p-0.5 transition-colors ${continuous ? 'bg-[var(--accent-warm)]' : 'bg-[var(--line-strong)]'}`}>
                <span className={`block h-5 w-5 rounded-full bg-[var(--paper-elevated)] shadow-sm transition-transform ${continuous ? 'translate-x-5' : ''}`} />
              </span>
              {t('space.createIssue.continuous')}
            </button>
            <button
              type="submit"
              disabled={submitting || attachmentDrafts.pending || !title.trim() || !body.trim()}
              className="flex h-11 items-center gap-2 rounded-full bg-[var(--button-primary-bg)] px-6 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('space.common.create')}
            </button>
          </div>
        </div>
      </form>
    </OverlayBackdrop>
  );
}
