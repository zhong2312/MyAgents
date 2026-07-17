import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Copy, Download, FileText, Loader2, Paperclip, Pencil, Save, Send, UploadCloud, X } from 'lucide-react';

import { spaceErrorMessage, type SpaceAttachment, type SpaceGoal, type SpaceRegisteredAgent, type SpaceSession } from '@/api/spaceCloud';
import Markdown from '@/components/Markdown';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import Tip from '@/components/Tip';
import { useToast } from '@/components/Toast';
import DropdownMenu, { type DropdownMenuSection } from '@/components/ui/DropdownMenu';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { copyPlainText } from '@/utils/markdownClipboard';
import { SpaceIdentityLine } from '@/pages/space/SpaceAvatar';
import { buildIssueCommandPrompt, getIssueStatusOptions, issueDisplayNumber, issueDisplayTitle } from '@/pages/space/spaceHelpers';
import {
  SPACE_VISIBLE_REFRESH_TTL_MS,
  type SpaceActions,
  type SpaceIssueDetailState,
} from '@/pages/space/spaceStore';
import { formatBytes, formatTime, SPACE_NARRATIVE_INSET_CLASS } from '@/pages/space/spaceUi';
import { IssueAttachmentDraftList } from './IssueAttachmentDraftList';
import { IssueTaskCard } from './IssueTaskCard';
import { useSpaceAttachmentDrafts } from './useSpaceAttachmentDrafts';

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function buildAttachmentDownloadCommand(attachmentId: string, spaceSlug: string): string {
  return `myagents space attachment download ${attachmentId} --space ${spaceSlug}`;
}

function IssueMarkdown({ children }: { children: string }) {
  return (
    <div className="ai-message-content text-[var(--ink-secondary)]">
      <Markdown raw preserveNewlines>{children}</Markdown>
    </div>
  );
}

export function IssueDetailDrawer({
  issueId,
  session,
  projects,
  goals,
  registeredAgents,
  detailState,
  actions,
  onClose,
  onNavigateIssue,
  previousIssueId,
  nextIssueId,
  onChanged,
}: {
  issueId: string;
  session: SpaceSession;
  projects: Project[];
  goals: SpaceGoal[];
  registeredAgents: SpaceRegisteredAgent[];
  detailState?: SpaceIssueDetailState;
  actions: SpaceActions;
  onClose: () => void;
  onNavigateIssue?: (issueId: string) => void;
  previousIssueId?: string | null;
  nextIssueId?: string | null;
  onChanged: () => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const [comment, setComment] = useState('');
  const commentAttachments = useSpaceAttachmentDrafts(() => toast.error(t('space.detail.commentAttachmentLimit')));
  const clearCommentAttachments = commentAttachments.clear;
  const [commentFilesPicking, setCommentFilesPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingIssue, setEditingIssue] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [savingIssue, setSavingIssue] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [downloadedAttachmentPaths, setDownloadedAttachmentPaths] = useState<Record<string, string>>({});
  const [downloadTargetAttachmentId, setDownloadTargetAttachmentId] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const editTitleRef = useRef<HTMLInputElement | null>(null);
  const downloadMenuRef = useRef<HTMLSpanElement | null>(null);
  const downloadMenuFirstItemRef = useRef<HTMLButtonElement | null>(null);
  const downloadMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const commentSendingRef = useRef(false);
  const activeIssueIdRef = useRef(issueId);
  activeIssueIdRef.current = issueId;
  const detail = detailState?.detail ?? null;
  const loading = detailState?.isLoading ?? true;
  const statusOptions = useMemo(
    () => getIssueStatusOptions({ session, issue: detail?.issue ?? null, t }),
    [detail?.issue, session, t],
  );
  const detailIssueId = detail?.issue.id;
  const detailIssueTitle = detail?.issue.title;
  const detailIssueBody = detail?.issue.body;
  const commentHasContent = Boolean(comment.trim() || commentAttachments.filePaths.length > 0);
  const commentComposerUnavailable = busy || commentAttachments.pending;
  const canSendComment = !commentComposerUnavailable && commentHasContent;
  const commentAttachmentPickerDisabled = commentFilesPicking
    || commentAttachments.pending
    || busy
    || commentAttachments.filePaths.length >= 5;
  // The Issue composer intentionally has a fixed shortcut independent of the
  // user-configurable AI chat send preference.
  const commentSendShortcut = navigator.platform.toLowerCase().includes('mac')
    ? '⌘ + Enter'
    : 'Ctrl + Enter';

  useCloseLayer(() => {
    onClose();
    return true;
  }, 230);
  useCloseLayer(() => {
    if (!downloadTargetAttachmentId) return false;
    setDownloadTargetAttachmentId(null);
    return true;
  }, 240);

  useEffect(() => {
    void actions.refreshIssueDetail(issueId, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, issueId, toast]);

  useEffect(() => {
    setDownloadedAttachmentPaths({});
    setDownloadTargetAttachmentId(null);
    setEditingIssue(false);
    setDraftTitle('');
    setDraftBody('');
    setComment('');
    clearCommentAttachments();
  }, [clearCommentAttachments, issueId]);

  useEffect(() => {
    if (!detailIssueId || editingIssue) return;
    setDraftTitle(detailIssueTitle ?? '');
    setDraftBody(detailIssueBody ?? '');
  }, [detailIssueBody, detailIssueId, detailIssueTitle, editingIssue]);

  useEffect(() => {
    if (!downloadTargetAttachmentId) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (downloadTargetAttachmentId && downloadMenuRef.current && !downloadMenuRef.current.contains(target)) {
        setDownloadTargetAttachmentId(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [downloadTargetAttachmentId]);

  useEffect(() => {
    if (downloadTargetAttachmentId && projects.length > 1) {
      window.setTimeout(() => downloadMenuFirstItemRef.current?.focus(), 0);
    }
  }, [downloadTargetAttachmentId, projects.length]);

  const changeStatus = async (option: { value: string; kind: 'set-status' | 'close-own' }) => {
    if (!detail) return;
    setStatusBusy(true);
    try {
      if (option.kind === 'close-own') {
        await actions.closeOwnIssue(issueId);
      } else {
        await actions.setIssueState(issueId, option.value);
      }
      toast.success(t('space.toasts.issueStatusUpdated'));
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setStatusBusy(false);
    }
  };

  const changeGoal = async (goalId: string | null) => {
    setGoalBusy(true);
    try {
      await actions.updateIssue({ issueId, goalId });
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      toast.success(t('space.toasts.issueGoalUpdated'));
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setGoalBusy(false);
    }
  };

  const assignIssue = async (assignee: { type: 'user' | 'registered_agent'; id: string }) => {
    try {
      await actions.setIssueAssignee(issueId, assignee);
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      toast.success(t('space.toasts.issueAssigneeUpdated'));
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
      throw error;
    }
  };

  const cancelAssignee = async () => {
    try {
      await actions.cancelIssueAssignee(issueId);
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      toast.success(t('space.toasts.issueAssigneeCancelled'));
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
      throw error;
    }
  };

  const loadOlderComments = async () => {
    const requestedIssueId = issueId;
    const scroll = scrollRef.current;
    const beforeHeight = scroll?.scrollHeight ?? 0;
    const beforeTop = scroll?.scrollTop ?? 0;
    setCommentsLoading(true);
    try {
      await actions.loadOlderIssueComments(requestedIssueId);
      window.requestAnimationFrame(() => {
        if (scroll && activeIssueIdRef.current === requestedIssueId) {
          scroll.scrollTop = beforeTop + (scroll.scrollHeight - beforeHeight);
        }
      });
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setCommentsLoading(false);
    }
  };

  const sendComment = async () => {
    if (!canSendComment || commentSendingRef.current) return;
    const requestedIssueId = issueId;
    const submittedComment = comment;
    const submittedFilePaths = commentAttachments.filePaths;
    commentSendingRef.current = true;
    setBusy(true);
    try {
      await actions.commentIssue(requestedIssueId, submittedComment.trim(), submittedFilePaths);
      if (activeIssueIdRef.current === requestedIssueId) {
        setComment(current => current === submittedComment ? '' : current);
        commentAttachments.replace(current => (
          current.map(item => item.path).join('\0') === submittedFilePaths.join('\0') ? [] : current
        ));
      }
      await actions.refreshIssueDetail(requestedIssueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      commentSendingRef.current = false;
      setBusy(false);
    }
  };

  const handleCommentKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter'
      || (!event.metaKey && !event.ctrlKey)
      || event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    void sendComment();
  };

  const pickCommentFiles = async () => {
    setCommentFilesPicking(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: t('space.detail.pickCommentAttachmentsTitle') });
      const next = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (next.length === 0) return;
      await commentAttachments.addPaths(next);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setCommentFilesPicking(false);
    }
  };

  const uploadAttachments = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: t('space.createIssue.pickAttachmentsTitle') });
      const filePaths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (filePaths.length === 0) return;
      setAttachmentUploading(true);
      const attachments = await actions.uploadIssueAttachments(issueId, filePaths);
      toast.success(t('space.toasts.attachmentsUploaded', { count: attachments.length }));
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setAttachmentUploading(false);
    }
  };

  const downloadAttachment = async (attachment: SpaceAttachment, workspacePath: string) => {
    if (!workspacePath) {
      toast.error(t('space.toasts.selectWorkspace'));
      return;
    }
    setDownloadTargetAttachmentId(null);
    setDownloadingAttachmentId(attachment.id);
    try {
      const result = await actions.downloadIssueAttachment({
        issueId,
        attachmentId: attachment.id,
        workspacePath,
        fileName: attachment.name,
      });
      setDownloadedAttachmentPaths((paths) => ({ ...paths, [attachment.id]: result.fullPath }));
      toast.success(t('space.toasts.attachmentDownloaded', { path: result.relativePath }));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setDownloadingAttachmentId(null);
    }
  };

  const requestAttachmentDownload = (attachment: SpaceAttachment, trigger?: HTMLButtonElement) => {
    if (projects.length === 0) {
      toast.error(t('space.toasts.noAgentWorkspaces'));
      return;
    }
    if (projects.length === 1) {
      void downloadAttachment(attachment, projects[0].path);
      return;
    }
    downloadMenuTriggerRef.current = trigger ?? null;
    setDownloadTargetAttachmentId((current) => (current === attachment.id ? null : attachment.id));
  };

  const copyAttachmentCommand = async (attachment: SpaceAttachment) => {
    try {
      await copyPlainText(buildAttachmentDownloadCommand(attachment.id, session.space.slug));
      toast.success(t('space.toasts.attachmentCommandCopied'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const copyDownloadedAttachmentPath = async (attachment: SpaceAttachment) => {
    const fullPath = downloadedAttachmentPaths[attachment.id];
    if (!fullPath) return;
    try {
      await copyPlainText(fullPath);
      toast.success(t('space.toasts.attachmentPathCopied'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const copyIssueCommand = async () => {
    try {
      await copyPlainText(buildIssueCommandPrompt({
        spaceName: session.space.name,
        spaceSlug: session.space.slug,
        issueId,
      }));
      toast.success(t('space.toasts.issueCommandCopied'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const startIssueEdit = () => {
    if (!detail) return;
    setDraftTitle(detail.issue.title);
    setDraftBody(detail.issue.body);
    setEditingIssue(true);
    window.setTimeout(() => editTitleRef.current?.focus(), 0);
  };

  const cancelIssueEdit = () => {
    if (detail) {
      setDraftTitle(detail.issue.title);
      setDraftBody(detail.issue.body);
    }
    setEditingIssue(false);
  };

  const saveIssueEdit = async () => {
    if (!detail) return;
    const title = draftTitle.trim();
    const body = draftBody.trim();
    if (!title || !body || savingIssue) return;
    const unchanged = title === detail.issue.title.trim() && body === detail.issue.body.trim();
    if (unchanged) {
      setEditingIssue(false);
      return;
    }
    setSavingIssue(true);
    try {
      await actions.updateIssue({ issueId, title, body });
      setEditingIssue(false);
      toast.success(t('space.toasts.issueSaved'));
      onChanged();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setSavingIssue(false);
    }
  };

  const issueAuthor = detail?.issue.creator ?? detail?.issue.author ?? null;
  const issueEditUnchanged = detail
    ? draftTitle.trim() === detail.issue.title.trim() && draftBody.trim() === detail.issue.body.trim()
    : true;
  const canSaveIssueEdit = Boolean(draftTitle.trim() && draftBody.trim()) && !issueEditUnchanged && !savingIssue;
  const commentCount = detail?.issue.commentCount ?? detail?.comments.items.length ?? 0;
  const displayNumber = detail ? issueDisplayNumber(detail.issue) : null;
  const issueActionSections: DropdownMenuSection[] = [
    {
      items: [
        ...(!editingIssue ? [{
          icon: <Pencil className="h-3.5 w-3.5" />,
          label: t('space.detail.editIssue'),
          onClick: startIssueEdit,
        }] : []),
        {
          icon: <Copy className="h-3.5 w-3.5" />,
          label: t('space.detail.copyIssueCommand'),
          onClick: () => void copyIssueCommand(),
        },
      ],
    },
  ];

  const renderAttachmentRow = (attachment: SpaceAttachment) => (
    <div
      key={attachment.id}
      className="group grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-sm text-[var(--ink-secondary)]"
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium text-[var(--ink-secondary)]">{attachment.name}</span>
        <small className="shrink-0 text-xs text-[var(--ink-subtle)]">{formatBytes(attachment.sizeBytes)}</small>
      </span>
      <span
        ref={downloadTargetAttachmentId === attachment.id ? downloadMenuRef : undefined}
        className="relative flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <button
          type="button"
          disabled={downloadingAttachmentId !== null}
          onClick={(event) => requestAttachmentDownload(attachment, event.currentTarget)}
          className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-muted)] outline-none transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-55"
          aria-label={t('space.detail.downloadAttachment', { name: attachment.name })}
          aria-haspopup={projects.length > 1 ? 'menu' : undefined}
          aria-expanded={projects.length > 1 ? downloadTargetAttachmentId === attachment.id : undefined}
          aria-controls={projects.length > 1 ? `attachment-download-menu-${attachment.id}` : undefined}
          title={projects.length > 1 ? t('space.detail.chooseDownloadWorkspace') : t('space.detail.downloadAttachment', { name: attachment.name })}
        >
          {downloadingAttachmentId === attachment.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        </button>
        {downloadTargetAttachmentId === attachment.id && projects.length > 1 && (
          <div
            id={`attachment-download-menu-${attachment.id}`}
            role="menu"
            aria-label={t('space.detail.downloadToAgentWorkspace')}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              setDownloadTargetAttachmentId(null);
              window.setTimeout(() => downloadMenuTriggerRef.current?.focus(), 0);
            }}
            className="absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg"
          >
            <div className="px-2 pb-1 text-xs font-semibold text-[var(--ink-muted)]">{t('space.detail.downloadToAgentWorkspace')}</div>
            {projects.map((project, index) => (
              <button
                key={project.path}
                ref={index === 0 ? downloadMenuFirstItemRef : undefined}
                type="button"
                role="menuitem"
                disabled={downloadingAttachmentId !== null}
                onClick={() => void downloadAttachment(attachment, project.path)}
                className="block h-9 w-full truncate rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-secondary)] outline-none transition-colors hover:bg-[var(--hover-bg)] focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)] disabled:cursor-wait disabled:opacity-60"
              >
                {project.displayName || project.name || basename(project.path)}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => void copyAttachmentCommand(attachment)}
          className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-muted)] outline-none transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)]"
          aria-label={t('space.detail.copyAttachmentCommand', { name: attachment.name })}
          title={t('space.detail.copyCliDownloadCommand')}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        {downloadedAttachmentPaths[attachment.id] && (
          <button
            type="button"
            onClick={() => void copyDownloadedAttachmentPath(attachment)}
            className="grid h-7 w-7 place-items-center rounded-lg text-[var(--ink-muted)] outline-none transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:ring-2 focus-visible:ring-[var(--accent-warm)]"
            aria-label={t('space.detail.copyAttachmentPath', { name: attachment.name })}
            title={t('space.detail.copyLocalPath')}
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </div>
  );

  return (
    <OverlayBackdrop onClose={onClose} className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm">
      <aside className="relative h-full w-[82vw] max-w-7xl border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl max-lg:w-[92vw] max-sm:w-full">
        <header className="absolute right-4 top-4 z-10 flex justify-end">
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" aria-label={t('space.detail.close')}>
            <X className="h-4 w-4" />
          </button>
        </header>

        {!detail && loading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('space.detail.loadingIssue')}
          </div>
        ) : !detail ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            {detailState?.error ?? t('space.detail.notFound')}
          </div>
        ) : (
          <section ref={scrollRef} className="h-full min-h-0 overflow-y-auto px-[56px] py-[58px] max-lg:px-8 max-sm:px-5">
            <div className="mx-auto max-w-[840px] pb-10">
              <article className="pb-7">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-normal text-[var(--ink-subtle)]">
                    {displayNumber && (
                      <>
                        <span className="text-[var(--ink-muted)]">{displayNumber}</span>
                        <span className="text-[var(--line-strong)]">·</span>
                      </>
                    )}
                    <SpaceIdentityLine
                      name={issueAuthor?.name ?? issueAuthor?.id ?? 'owner'}
                      avatarUrl={issueAuthor?.avatarUrl}
                      type={issueAuthor?.type ?? detail.issue.createdByType ?? 'user'}
                      avatarSize={20}
                      nameClassName="font-medium text-[var(--ink)]"
                      showAgentTag
                      agentOwnerName={issueAuthor?.owner?.name}
                    />
                    <span className="text-[var(--line-strong)]">·</span>
                    <span>{formatTime(detail.issue.createdAt)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={!previousIssueId || !onNavigateIssue}
                      onClick={() => previousIssueId && onNavigateIssue?.(previousIssueId)}
                      className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={t('space.detail.previousIssue')}
                      title={t('space.detail.previousIssue')}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={!nextIssueId || !onNavigateIssue}
                      onClick={() => nextIssueId && onNavigateIssue?.(nextIssueId)}
                      className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={t('space.detail.nextIssue')}
                      title={t('space.detail.nextIssue')}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <DropdownMenu
                      sections={issueActionSections}
                      size="md"
                      minWidth={172}
                      zIndex={231}
                    />
                  </div>
                </div>
                {editingIssue ? (
                  <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--paper)]/70 p-4 shadow-sm">
                    <input
                      ref={editTitleRef}
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      className="w-full border-0 bg-transparent text-2xl font-semibold leading-snug text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
                      placeholder={t('space.detail.titlePlaceholder')}
                      aria-label={t('space.detail.titleLabel')}
                    />
                    <textarea
                      value={draftBody}
                      onChange={(event) => setDraftBody(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void saveIssueEdit();
                        }
                      }}
                      className="mt-4 min-h-[220px] w-full resize-y border-0 bg-transparent p-0 text-base leading-7 text-[var(--ink-secondary)] outline-none placeholder:text-[var(--ink-muted)]"
                      placeholder={t('space.detail.bodyPlaceholder')}
                      aria-label={t('space.detail.bodyLabel')}
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={savingIssue}
                        onClick={cancelIssueEdit}
                        className="inline-flex h-9 items-center rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                      >
                        {t('space.common.cancel')}
                      </button>
                      <button
                        type="button"
                        disabled={!canSaveIssueEdit}
                        onClick={() => void saveIssueEdit()}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                      >
                        {savingIssue ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        {t('space.common.save')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mt-4">
                      <h2 className="max-w-[68ch] text-2xl font-semibold leading-snug text-[var(--ink)]">{issueDisplayTitle(detail.issue)}</h2>
                    </div>
                    <div className={`mt-5 ${SPACE_NARRATIVE_INSET_CLASS}`}>
                      <IssueMarkdown>{detail.issue.body}</IssueMarkdown>
                    </div>
                  </>
                )}

                <section className="mt-7">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
                      <span>{t('space.detail.attachments')}</span>
                      <span className="text-xs font-semibold text-[var(--ink-subtle)]">{detail.attachments.length}</span>
                    </h3>
                    <button
                      type="button"
                      disabled={attachmentUploading}
                      onClick={() => void uploadAttachments()}
                      className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                      title={t('space.detail.uploadAttachment')}
                    >
                      {attachmentUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                      {t('space.common.upload')}
                    </button>
                  </div>
                  {detail.attachments.length === 0 ? (
                    <div className="py-2 text-sm text-[var(--ink-muted)]">{t('space.detail.emptyAttachments')}</div>
                  ) : (
                    <div className="divide-y divide-dashed divide-[var(--line-subtle)]">
                      {detail.attachments.map(renderAttachmentRow)}
                    </div>
                  )}
                </section>

                <IssueTaskCard
                  issue={detail.issue}
                  goalReference={detail.goalReference}
                  goals={goals}
                  session={session}
                  agents={registeredAgents}
                  statusOptions={statusOptions}
                  statusBusy={statusBusy}
                  goalBusy={goalBusy}
                  onChangeStatus={changeStatus}
                  onChangeGoal={changeGoal}
                  onAssign={assignIssue}
                  onCancelAssignee={cancelAssignee}
                />
              </article>

              <section>
                <h3 className="mb-5 flex items-center gap-2 text-lg font-semibold text-[var(--ink)]">
                  <span>{t('space.detail.comments')}</span>
                  <small className="text-xs font-semibold text-[var(--ink-subtle)]">{t('space.detail.commentCount', { count: commentCount })}</small>
                </h3>
                <div className="divide-y divide-[var(--line-subtle)]">
                  {detail.comments.hasMore && detail.comments.nextCursor && (
                    <div className="pb-4">
                      <button
                        type="button"
                        disabled={commentsLoading}
                        onClick={() => void loadOlderComments()}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-60"
                      >
                        {commentsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {t('space.detail.loadOlderComments')}
                      </button>
                    </div>
                  )}
                  {detail.comments.items.length === 0 ? (
                    <div className="py-3 text-sm text-[var(--ink-muted)]">
                      {t('space.detail.emptyComments')}
                    </div>
                  ) : (
                    detail.comments.items.map((item) => (
                      <article key={item.id} className="py-5 first:pt-0">
                        <div className="mb-2 flex items-center gap-2 text-sm font-normal text-[var(--ink-subtle)]">
                          <SpaceIdentityLine
                            name={item.author.name ?? item.author.id ?? item.author.type}
                            avatarUrl={item.author.avatarUrl}
                            type={item.author.type}
                            avatarSize={22}
                            nameClassName="font-medium text-[var(--ink)]"
                            showAgentTag
                            agentOwnerName={item.author.owner?.name}
                          />
                          <span>{formatTime(item.createdAt)}</span>
                        </div>
                        <div className={SPACE_NARRATIVE_INSET_CLASS}>
                          {item.body.trim() && <IssueMarkdown>{item.body}</IssueMarkdown>}
                          {(item.attachments?.length ?? 0) > 0 && (
                            <div className={`${item.body.trim() ? 'mt-3' : ''} divide-y divide-[var(--line-subtle)] border-b border-[var(--line-subtle)]`}>
                              {(item.attachments ?? []).map(renderAttachmentRow)}
                            </div>
                          )}
                        </div>
                      </article>
                    ))
                  )}
                </div>

                <div className="mt-6 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 shadow-sm">
                  <IssueAttachmentDraftList
                    drafts={commentAttachments.drafts}
                    onRemove={commentAttachments.remove}
                    removeLabel={(name) => t('space.detail.removeCommentAttachment', { name })}
                    className="border-b border-[var(--line-subtle)] bg-[var(--paper-inset)]/45 px-4 py-1"
                  />
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    onKeyDown={handleCommentKeyDown}
                    className="min-h-[104px] w-full resize-none border-0 bg-transparent p-4 text-base leading-7 text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
                    placeholder={t('space.detail.commentPlaceholder')}
                  />
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 px-2.5 pb-2.5">
                    <Tip
                      label={t('space.detail.uploadAttachmentAria')}
                      disabled={commentAttachmentPickerDisabled}
                    >
                      <button
                        type="button"
                        disabled={commentAttachmentPickerDisabled}
                        onClick={() => void pickCommentFiles()}
                        className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                        aria-label={t('space.detail.uploadAttachmentAria')}
                      >
                        {commentFilesPicking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                      </button>
                    </Tip>
                    <span />
                    <Tip
                      label={t('space.detail.sendComment')}
                      shortcut={commentSendShortcut}
                      align="end"
                      disabled={commentComposerUnavailable}
                    >
                      <button
                        type="button"
                        disabled={!canSendComment}
                        onClick={() => void sendComment()}
                        className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--button-primary-bg)] text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                        aria-label={t('space.detail.sendComment')}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </button>
                    </Tip>
                  </div>
                </div>
              </section>
            </div>
          </section>
        )}
      </aside>
    </OverlayBackdrop>
  );
}
