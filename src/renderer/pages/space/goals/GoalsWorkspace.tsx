import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Edit3,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Target,
  Trash2,
  X,
} from 'lucide-react';

import type { SpaceGoal, SpaceSession } from '@/api/spaceCloud';
import { spaceErrorMessage } from '@/api/spaceCloud';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import type { SpaceActions } from '@/pages/space/spaceStore';
import { SPACE_NARRATIVE_INSET_CLASS } from '@/pages/space/spaceUi';

type GoalTreeNode = SpaceGoal & {
  children: GoalTreeNode[];
};

type DetailMode = 'empty' | 'view' | 'edit' | 'create';
type BusyState = 'refresh' | 'save' | 'delete' | null;

function buildGoalTree(goals: SpaceGoal[]): GoalTreeNode[] {
  const nodes = new Map<string, GoalTreeNode>();
  for (const goal of goals) {
    nodes.set(goal.id, { ...goal, children: [] });
  }
  const roots: GoalTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.parentGoalId ?? '';
    const parent = parentId ? nodes.get(parentId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (items: GoalTreeNode[]) => {
    items.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.createdAt.localeCompare(b.createdAt);
    });
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
}

function findGoal(goals: SpaceGoal[], id: string | null): SpaceGoal | null {
  if (!id) return null;
  return goals.find((goal) => goal.id === id) ?? null;
}

function isRootGoal(goal: SpaceGoal | null, session: SpaceSession): boolean {
  if (!goal) return false;
  return goal.parentGoalId == null || goal.id === session.space.rootGoalId;
}

function directChildren(goals: SpaceGoal[], parentGoalId: string): SpaceGoal[] {
  return goals
    .filter((goal) => goal.parentGoalId === parentGoalId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function goalPath(goals: SpaceGoal[], goal: SpaceGoal | null): SpaceGoal[] {
  if (!goal) return [];
  const byId = new Map(goals.map((item) => [item.id, item]));
  const path: SpaceGoal[] = [];
  let current: SpaceGoal | undefined = goal;
  const visited = new Set<string>();
  for (let depth = 0; current && depth < 64; depth += 1) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    path.unshift(current);
    const parentId: string = current.parentGoalId ?? '';
    current = parentId ? byId.get(parentId) : undefined;
  }
  return path;
}

function compactPath(path: SpaceGoal[]): { hidden: boolean; goals: SpaceGoal[] } {
  if (path.length <= 2) return { hidden: false, goals: path };
  return { hidden: true, goals: path.slice(-2) };
}

export function GoalsWorkspace({
  admin,
  session,
  goals,
  actions,
  onRefresh,
  onOpenIssuesForGoal,
}: {
  admin: boolean;
  session: SpaceSession;
  goals: SpaceGoal[];
  actions: SpaceActions;
  onRefresh: () => Promise<void>;
  onOpenIssuesForGoal: (goalId: string) => void;
}) {
  const { t } = useTranslation('app');
  const toast = useToast();
  const tree = useMemo(() => buildGoalTree(goals), [goals]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [mode, setMode] = useState<DetailMode>('empty');
  const [createParentGoalId, setCreateParentGoalId] = useState<string | null>(null);
  const selectedGoal = findGoal(goals, selectedGoalId);
  const createParentGoal = findGoal(goals, createParentGoalId);
  const children = useMemo(() => (selectedGoal ? directChildren(goals, selectedGoal.id) : []), [goals, selectedGoal]);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContext, setDraftContext] = useState('');
  const [busy, setBusy] = useState<BusyState>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (!selectedGoalId) return;
    if (goals.some((goal) => goal.id === selectedGoalId)) return;
    setSelectedGoalId(null);
    setCreateParentGoalId(null);
    setMode('empty');
  }, [goals, selectedGoalId]);

  const selectGoal = (goalId: string) => {
    setSelectedGoalId(goalId);
    setCreateParentGoalId(null);
    setDeleteConfirmOpen(false);
    setMode('view');
  };

  const resetDraftFromGoal = (goal: SpaceGoal) => {
    setDraftTitle(goal.title);
    setDraftContext(goal.context);
  };

  const startEdit = () => {
    if (!selectedGoal || !admin) return;
    resetDraftFromGoal(selectedGoal);
    setMode('edit');
  };

  const startCreateChild = (parent: SpaceGoal) => {
    if (!admin) return;
    setSelectedGoalId(parent.id);
    setCreateParentGoalId(parent.id);
    setDraftTitle('');
    setDraftContext('');
    setDeleteConfirmOpen(false);
    setMode('create');
  };

  const cancelEdit = () => {
    setDeleteConfirmOpen(false);
    if (mode === 'create') {
      setSelectedGoalId(null);
      setCreateParentGoalId(null);
      setDraftTitle('');
      setDraftContext('');
      setMode('empty');
      return;
    }
    if (selectedGoal) resetDraftFromGoal(selectedGoal);
    setMode(selectedGoal ? 'view' : 'empty');
  };

  const refresh = async () => {
    setBusy('refresh');
    try {
      await onRefresh();
      toast.success(t('space.toasts.refreshed'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const titleReady = draftTitle.trim().length > 0;
  const contextReady = draftContext.trim().length > 0;
  const dirty = selectedGoal ? draftTitle.trim() !== selectedGoal.title || draftContext.trim() !== selectedGoal.context : false;
  const canSave =
    admin &&
    busy === null &&
    titleReady &&
    contextReady &&
    ((mode === 'edit' && selectedGoal && dirty) || (mode === 'create' && createParentGoal));
  const canDelete = admin && mode === 'edit' && selectedGoal !== null && !isRootGoal(selectedGoal, session);

  const save = async () => {
    if (!canSave) return;
    setBusy('save');
    try {
      if (mode === 'create') {
        if (!createParentGoal) return;
        const goal = await actions.createGoal({
          parentGoalId: createParentGoal.id,
          title: draftTitle.trim(),
          context: draftContext.trim(),
        });
        setSelectedGoalId(goal.id);
        setCreateParentGoalId(null);
        resetDraftFromGoal(goal);
        setMode('view');
        toast.success(t('space.toasts.goalCreated'));
        return;
      }

      if (!selectedGoal) return;
      const goal = await actions.updateGoal({
        goalId: selectedGoal.id,
        title: draftTitle.trim(),
        context: draftContext.trim(),
      });
      setSelectedGoalId(goal.id);
      resetDraftFromGoal(goal);
      setMode('view');
      toast.success(t('space.toasts.goalSaved'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const deleteGoal = async () => {
    if (!canDelete || !selectedGoal || busy !== null) return;
    setBusy('delete');
    try {
      await actions.archiveGoal(selectedGoal.id);
      setDeleteConfirmOpen(false);
      setSelectedGoalId(null);
      setCreateParentGoalId(null);
      setMode('empty');
      toast.success(t('space.toasts.goalDeleted'));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
        <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-xl border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <GitBranch className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-[var(--ink)]">{t('space.goals.title')}</h2>
              <p className="truncate text-xs text-[var(--ink-muted)]">{t('space.goals.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-transparent text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label={t('space.common.refresh')}
            title={t('space.common.refresh')}
          >
            {busy === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </section>

        <main className="grid min-h-0 grid-cols-[360px_minmax(0,1fr)] max-lg:grid-cols-1">
          <section className="min-h-0 overflow-y-auto border-r border-[var(--line)] bg-[var(--paper)]/45 px-4 py-4 max-lg:border-b max-lg:border-r-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase text-[var(--ink-muted)]/60">
                {t('space.goals.tree')}
              </span>
              <span className="rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
                {t('space.goals.goalCount', { count: goals.length })}
              </span>
            </div>
            {tree.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-4 text-sm text-[var(--ink-muted)]">
                {t('space.goals.empty')}
              </div>
            ) : (
              <div className="grid gap-1">
                {tree.map((node) => (
                  <GoalTreeRow
                    key={node.id}
                    node={node}
                    selectedGoalId={selectedGoalId}
                    onSelect={selectGoal}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="min-h-0 overflow-y-auto px-6 py-5">
            <div className="mx-auto min-h-full max-w-[920px]">
              {mode === 'empty' && <GoalEmptyState title={t('space.goals.emptyTitle')} hint={t('space.goals.emptyHint')} />}

              {mode === 'view' && selectedGoal && (
                <GoalView
                  admin={admin}
                  goal={selectedGoal}
                  goals={goals}
                  childGoals={children}
                  session={session}
                  onEdit={startEdit}
                  onSelectGoal={selectGoal}
                  onCreateChild={startCreateChild}
                  onOpenIssuesForGoal={onOpenIssuesForGoal}
                />
              )}

              {(mode === 'edit' || mode === 'create') && (
                <GoalEdit
                  mode={mode}
                  goals={goals}
                  goal={selectedGoal}
                  parentGoal={createParentGoal}
                  session={session}
                  draftTitle={draftTitle}
                  draftContext={draftContext}
                  busy={busy}
                  canSave={Boolean(canSave)}
                  canDelete={Boolean(canDelete)}
                  onSelectGoal={selectGoal}
                  onTitleChange={setDraftTitle}
                  onContextChange={setDraftContext}
                  onCancel={cancelEdit}
                  onSave={() => void save()}
                  onDelete={() => setDeleteConfirmOpen(true)}
                />
              )}
            </div>
          </section>
        </main>
      </div>
      {deleteConfirmOpen && selectedGoal && (
        <ConfirmDialog
          title={t('space.goals.deleteTitle')}
          message={t('space.goals.deleteMessage', {
            name: selectedGoal.title,
          })}
          confirmText={t('space.goals.delete')}
          cancelText={t('space.common.cancel')}
          confirmVariant="danger"
          loading={busy === 'delete'}
          disableEnterShortcut
          onConfirm={() => void deleteGoal()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
    </>
  );
}

function GoalEmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="grid min-h-[420px] place-items-center">
      <div className="grid max-w-sm justify-items-center gap-3 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 text-[var(--ink-subtle)]">
          <Target className="h-6 w-6" />
        </span>
        <div className="grid gap-1">
          <h3 className="text-lg font-semibold text-[var(--ink)]">{title}</h3>
          <p className="text-sm leading-6 text-[var(--ink-muted)]">{hint}</p>
        </div>
      </div>
    </div>
  );
}

function GoalView({
  admin,
  goal,
  goals,
  childGoals,
  session,
  onEdit,
  onSelectGoal,
  onCreateChild,
  onOpenIssuesForGoal,
}: {
  admin: boolean;
  goal: SpaceGoal;
  goals: SpaceGoal[];
  childGoals: SpaceGoal[];
  session: SpaceSession;
  onEdit: () => void;
  onSelectGoal: (goalId: string) => void;
  onCreateChild: (goal: SpaceGoal) => void;
  onOpenIssuesForGoal: (goalId: string) => void;
}) {
  const { t } = useTranslation('app');
  return (
    <article className="grid gap-7 pb-10">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--line-subtle)] pb-4">
        <GoalBreadcrumb goals={goals} goal={goal} onSelectGoal={onSelectGoal} />
        <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpenIssuesForGoal(goal.id)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-2.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              {t('space.goals.viewIssues')}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            {admin && (
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--button-secondary-bg)] px-2.5 text-sm font-medium text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
              >
                <Edit3 className="h-3.5 w-3.5" />
                {t('space.goals.edit')}
              </button>
            )}
        </div>
      </header>

      <section className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase text-[var(--ink-muted)]/60">
            {t('space.goals.goalLabel')}
          </span>
          {isRootGoal(goal, session) && (
            <span className="rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
              {t('space.goals.root')}
            </span>
          )}
        </div>
        <h3 className="text-xl font-semibold text-[var(--ink)]">{goal.title}</h3>
      </section>

      <section className={SPACE_NARRATIVE_INSET_CLASS}>
        <p className="whitespace-pre-wrap text-base leading-7 text-[var(--ink-secondary)]">{goal.context}</p>
      </section>

      <section className="grid gap-3 border-t border-[var(--line-subtle)] pt-5">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-base font-semibold text-[var(--ink)]">{t('space.goals.children')}</h4>
          <span className="rounded-md bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
            {t('space.goals.childCount', { count: childGoals.length })}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/45">
          {childGoals.length === 0 ? (
            <div className="px-4 py-5 text-sm text-[var(--ink-muted)]">{t('space.goals.noChildren')}</div>
          ) : (
            <div className="divide-y divide-[var(--line-subtle)]">
              {childGoals.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  onClick={() => onSelectGoal(child.id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--hover-bg)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-[var(--ink)]">{child.title}</span>
                    <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">{child.context}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-[var(--ink-subtle)]" />
                </button>
              ))}
            </div>
          )}
          {admin && (
            <button
              type="button"
              onClick={() => onCreateChild(goal)}
              className="flex min-h-11 w-full items-center justify-center gap-2 border-t border-[var(--line-subtle)] bg-[var(--paper-elevated)]/70 px-4 text-sm font-semibold text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
            >
              <Plus className="h-4 w-4" />
              {t('space.goals.newChild')}
            </button>
          )}
        </div>
      </section>
    </article>
  );
}

function GoalEdit({
  mode,
  goals,
  goal,
  parentGoal,
  session,
  draftTitle,
  draftContext,
  busy,
  canSave,
  canDelete,
  onSelectGoal,
  onTitleChange,
  onContextChange,
  onCancel,
  onSave,
  onDelete,
}: {
  mode: 'edit' | 'create';
  goals: SpaceGoal[];
  goal: SpaceGoal | null;
  parentGoal: SpaceGoal | null;
  session: SpaceSession;
  draftTitle: string;
  draftContext: string;
  busy: BusyState;
  canSave: boolean;
  canDelete: boolean;
  onSelectGoal: (goalId: string) => void;
  onTitleChange: (value: string) => void;
  onContextChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('app');
  const currentGoal = mode === 'edit' ? goal : parentGoal;
  return (
    <article className="grid gap-6 pb-10">
      <header className="grid gap-3 border-b border-[var(--line-subtle)] pb-5">
        {mode === 'edit' && goal && <GoalBreadcrumb goals={goals} goal={goal} onSelectGoal={onSelectGoal} />}
        {mode === 'create' && parentGoal && (
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-muted)]">
            <span>{t('space.goals.parentGoal')}</span>
            <GoalBreadcrumb goals={goals} goal={parentGoal} onSelectGoal={onSelectGoal} currentClickable />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-xl border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
            {mode === 'create' ? <Plus className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <h3 className="text-xl font-semibold text-[var(--ink)]">
              {mode === 'create' ? t('space.goals.createTitle') : t('space.goals.editTitle')}
            </h3>
            {currentGoal && isRootGoal(currentGoal, session) && mode === 'edit' && (
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{t('space.goals.rootEditHint')}</p>
            )}
          </div>
        </div>
      </header>

      <section className="grid gap-4">
        <div className="grid gap-1.5">
          <label className="text-xs font-semibold uppercase text-[var(--ink-muted)]/60" htmlFor="space-goal-title">
            {t('space.goals.titleLabel')}
          </label>
          <input
            id="space-goal-title"
            value={draftTitle}
            onChange={(event) => onTitleChange(event.target.value)}
            className="h-10 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
            placeholder={t('space.goals.titlePlaceholder')}
          />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs font-semibold uppercase text-[var(--ink-muted)]/60" htmlFor="space-goal-context">
            {t('space.goals.contextLabel')}
          </label>
          <textarea
            id="space-goal-context"
            value={draftContext}
            onChange={(event) => onContextChange(event.target.value)}
            className="min-h-52 resize-y rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 py-2 text-sm leading-6 text-[var(--ink-secondary)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
            placeholder={t('space.goals.contextPlaceholder')}
          />
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line-subtle)] pt-4">
        <div>
          {canDelete && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={onDelete}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--error)]/25 bg-[var(--error)]/10 px-3 text-sm font-semibold text-[var(--error)] transition-colors hover:bg-[var(--error)]/15 disabled:cursor-wait disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
              {t('space.goals.delete')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={onCancel}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-3 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-60"
          >
            <X className="h-4 w-4" />
            {t('space.common.cancel')}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={onSave}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {mode === 'create' ? t('space.goals.createChild') : t('space.common.save')}
          </button>
        </div>
      </footer>
    </article>
  );
}

function GoalBreadcrumb({
  goals,
  goal,
  onSelectGoal,
  currentClickable = false,
}: {
  goals: SpaceGoal[];
  goal: SpaceGoal;
  onSelectGoal: (goalId: string) => void;
  currentClickable?: boolean;
}) {
  const path = compactPath(goalPath(goals, goal));
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-xs font-semibold text-[var(--ink-muted)]">
      {path.hidden && <span className="text-[var(--ink-subtle)]">..</span>}
      {path.hidden && <span className="text-[var(--ink-subtle)]">/</span>}
      {path.goals.map((item, index) => {
        const isCurrent = item.id === goal.id;
        return (
          <span key={item.id} className="inline-flex min-w-0 items-center gap-1">
            {index > 0 && <span className="text-[var(--ink-subtle)]">/</span>}
            {isCurrent && !currentClickable ? (
              <span className="max-w-48 truncate text-[var(--ink)]">{item.title}</span>
            ) : (
              <button
                type="button"
                onClick={() => onSelectGoal(item.id)}
                className="max-w-48 truncate rounded-md px-1 py-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              >
                {item.title}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function GoalTreeRow({
  node,
  selectedGoalId,
  onSelect,
}: {
  node: GoalTreeNode;
  selectedGoalId: string | null;
  onSelect: (goalId: string) => void;
}) {
  const selected = selectedGoalId === node.id;
  return (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={`grid min-h-9 w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors ${
          selected
            ? 'bg-[var(--accent-warm-subtle)] font-semibold text-[var(--accent-warm)]'
            : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
        }`}
        style={{ paddingLeft: `${8 + Math.min(node.depth, 6) * 18}px` }}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{node.title}</span>
      </button>
      {node.children.length > 0 && (
        <div className="grid gap-1">
          {node.children.map((child) => (
            <GoalTreeRow key={child.id} node={child} selectedGoalId={selectedGoalId} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
