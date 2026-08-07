// Agent tasks section — display cron tasks associated with this agent, clickable to open detail
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getWorkspaceCronTasks, deleteCronTask, startCronTask, stopCronTask } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { useToast } from '@/components/Toast';
import CronTaskDetailPanel from '@/components/CronTaskDetailPanel';
import { currentSupportedLocale, formatPastRelativeTime } from '@/i18n/format';
import { formatCronIntervalLabel, formatCronStatusText } from '@/utils/cronTaskI18n';
import { humanizeCron } from '@/utils/taskCenterUtils';
import { isManagedScheduledJob } from '../../../../shared/managedScheduledJob';
import type { SupportedLocale } from '../../../../shared/i18n';
import type { TFunction } from 'i18next';

function formatRelativeTime(isoStr: string): string {
  return formatPastRelativeTime(new Date(isoStr).getTime(), currentSupportedLocale());
}

type TaskT = TFunction<'task'>;

function formatTaskSchedule(task: CronTask, tTask: TaskT, locale: SupportedLocale): string {
  if (task.schedule) {
    switch (task.schedule.kind) {
      case 'at':
        return tTask('cron.schedule.onceAt', { time: new Date(task.schedule.at).toLocaleString(locale) });
      case 'every':
        return tTask('cron.schedule.every', { interval: formatCronIntervalLabel(task.schedule.minutes, tTask) });
      case 'cron':
        return humanizeCron(task.schedule.expr, locale) ?? tTask('cron.schedule.cron', { expr: task.schedule.expr });
      case 'loop':
        return tTask('cron.schedule.loop');
    }
  }
  return tTask('cron.schedule.every', { interval: formatCronIntervalLabel(task.intervalMinutes, tTask) });
}

function cronStatusText(status: string, tTask: TaskT): string {
  if (status === 'running' || status === 'stopped') return formatCronStatusText(status, tTask);
  return status;
}

function cronStatusDotColor(status: string): string {
  if (status === 'running') return 'var(--success)';
  return 'var(--ink-subtle)';
}

interface AgentTasksSectionProps {
  workspacePath: string;
}

export default function AgentTasksSection({ workspacePath }: AgentTasksSectionProps) {
  const { t } = useTranslation('settings');
  const { t: tTask } = useTranslation('task');
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<CronTask | null>(null);
  const toast = useToast();
  const toastRef = useRef(toast);
  const isMountedRef = useRef(true);

  useEffect(() => { toastRef.current = toast; }, [toast]);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const tasks = await getWorkspaceCronTasks(workspacePath);
      if (!isMountedRef.current) return;
      setTasks(tasks);
    } catch {
      // Silent — tasks are optional
    }
  }, [workspacePath]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadTasks fetches from external API then sets state, which is the correct pattern for effects
    void loadTasks();
  }, [loadTasks]);

  const handleDelete = useCallback(async (taskId: string) => {
    try {
      await deleteCronTask(taskId);
      if (!isMountedRef.current) return;
      setSelectedTask(null);
      toastRef.current.success(t('agentSettings.tasks.deleted'));
      void loadTasks();
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(t('agentSettings.tasks.deleteFailed', { message: err instanceof Error ? err.message : String(err) }));
    }
  }, [loadTasks, t]);

  const handleResume = useCallback(async (taskId: string) => {
    try {
      await startCronTask(taskId);
      if (!isMountedRef.current) return;
      setSelectedTask(null);
      toastRef.current.success(t('agentSettings.tasks.resumed'));
      void loadTasks();
    } catch (err) {
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        setSelectedTask(null);
        void loadTasks();
        return;
      }
      toastRef.current.error(t('agentSettings.tasks.resumeFailed', { message: msg }));
    }
  }, [loadTasks, t]);

  const handleStop = useCallback(async (taskId: string) => {
    try {
      await stopCronTask(taskId, '手动停止');
      if (!isMountedRef.current) return;
      setSelectedTask(null);
      toastRef.current.success(t('agentSettings.tasks.stopped'));
      void loadTasks();
    } catch (err) {
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        setSelectedTask(null);
        void loadTasks();
        return;
      }
      toastRef.current.error(t('agentSettings.tasks.stopFailed', { message: msg }));
    }
  }, [loadTasks, t]);

  const handleUpdated = useCallback((updatedTask: CronTask) => {
    setTasks(current => current.map(task => task.id === updatedTask.id ? updatedTask : task));
    setSelectedTask(updatedTask);
    void loadTasks();
  }, [loadTasks]);

  // Only show active (running) tasks, sorted by date descending (newest first)
  const activeTasks = useMemo(() =>
    tasks
      .filter(t => t.status === 'running' && !isManagedScheduledJob(t))
      .sort((a, b) => {
        const dateA = new Date(a.updatedAt ?? a.createdAt).getTime();
        const dateB = new Date(b.updatedAt ?? b.createdAt).getTime();
        return dateB - dateA;
      }),
    [tasks],
  );
  const locale = currentSupportedLocale();

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium text-[var(--ink)]">
        {t('agentSettings.tasks.title')}
      </h3>

      {activeTasks.length === 0 ? (
        <p className="text-xs text-[var(--ink-subtle)]">
          {t('agentSettings.tasks.empty')}
        </p>
      ) : (
        <div className="space-y-2">
          {activeTasks.map(task => (
            <button
              key={task.id}
              type="button"
              onClick={() => setSelectedTask(task)}
              className="flex w-full items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)]"
            >
              <div
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: cronStatusDotColor(task.status) }}
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium truncate text-[var(--ink)]">
                  {task.name || t('agentSettings.tasks.unnamed')}
                </span>
                <div className="text-xs text-[var(--ink-subtle)]">
                  {formatTaskSchedule(task, tTask, locale)} · {cronStatusText(task.status, tTask)}
                </div>
              </div>
              {task.lastExecutedAt && (
                <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                  {formatRelativeTime(task.lastExecutedAt)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectedTask && (
        <CronTaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onDelete={handleDelete}
          onResume={handleResume}
          onStop={handleStop}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  );
}
