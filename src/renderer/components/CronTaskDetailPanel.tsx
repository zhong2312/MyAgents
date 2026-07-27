/**
 * CronTaskDetailPanel — Detail + Edit view for a scheduled task.
 * Design language aligned with CronTaskSettingsModal and Agent Settings panels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpToLine, BarChart2, Bell, Check, Clock, FileText, Flag, FolderOpen, History, MessageSquare, Pencil, Play, Square, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CronTask, CronSchedule, CronEndConditions } from '@/types/cronTask';
import {
    getCronStatusColor,
    MIN_CRON_INTERVAL,
} from '@/types/cronTask';
import { getFolderName } from '@/utils/taskCenterUtils';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import { isSupportedLocale } from '@/../shared/i18n';
import { isManagedScheduledJob } from '@/../shared/managedScheduledJob';
import WorkspaceIcon from './launcher/WorkspaceIcon';
import { useToast } from './Toast';
import { useConfig } from '@/hooks/useConfig';
import ConfirmDialog from './ConfirmDialog';
import CustomSelect from './CustomSelect';
import TaskRunHistory from './scheduled-tasks/TaskRunHistory';
import ScheduleTypeTabs from './scheduled-tasks/ScheduleTypeTabs';
import * as cronClient from '@/api/cronTaskClient';
import { getSessionDetails, type SessionMetadata } from '@/api/sessionClient';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import { useDeliveryChannels } from '@/hooks/useDeliveryChannels';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { buildAgentPatchFromSessionSnapshot } from '@/utils/sessionSnapshotAgentSync';
import {
    formatCronNextExecution,
    formatCronResumeBlockReason,
    formatCronScheduleDescription,
    formatCronStatusText,
} from '@/utils/cronTaskI18n';

interface CronTaskDetailPanelProps {
    task: CronTask;
    botInfo?: { name: string; platform: string };
    onClose: () => void;
    onDelete: (taskId: string) => Promise<void>;
    onResume: (taskId: string) => Promise<void>;
    onStop?: (taskId: string) => Promise<void>;
    onUpdated?: (task: CronTask) => void;
    /** Open a session in a new tab (for execution history click) */
    onOpenSession?: (sessionId: string) => void;
}

const INPUT_CLS = 'w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors';

function SectionHeader({ icon: Icon, children }: { icon?: typeof Clock; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2">
            {Icon && <Icon className="h-4 w-4 text-[var(--ink-muted)]" />}
            <h4 className="text-sm font-semibold text-[var(--ink)]">{children}</h4>
        </div>
    );
}

function DetailTag({ label }: { label: string }) {
    return <span className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--ink-muted)]">{label}</span>;
}

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
    return (
        <button type="button" role="switch" aria-checked={enabled} onClick={() => onChange(!enabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}>
            <span className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
    );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-sm text-[var(--ink)]">
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${checked ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]' : 'border-[var(--line-strong)] bg-transparent'}`}>
                {checked && <Check className="h-2.5 w-2.5" />}
            </span>
            {label}
        </button>
    );
}

export default function CronTaskDetailPanel({ task, botInfo, onClose, onDelete, onResume, onStop, onUpdated, onOpenSession }: CronTaskDetailPanelProps) {
    const { t, i18n } = useTranslation('task');
    const locale = isSupportedLocale(i18n.language) ? i18n.language : 'zh-CN';
    useCloseLayer(() => { onClose(); return true; }, 50);

    const toast = useToast();
    const { config, projects } = useConfig();
    const isMountedRef = useRef(true);
    useEffect(() => () => { isMountedRef.current = false; }, []);
    const project = useMemo(() => projects.find(p => workspacePathsEqual(p.path, task.workspacePath)), [projects, task.workspacePath]);
    const isManagedTask = isManagedScheduledJob(task);
    const agent = useMemo(
        () => project?.agentId ? config.agents?.find(a => a.id === project.agentId) : undefined,
        [config.agents, project?.agentId],
    );
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showStopConfirm, setShowStopConfirm] = useState(false);
    const [showSyncConfirm, setShowSyncConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isResuming, setIsResuming] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [sessionMeta, setSessionMeta] = useState<SessionMetadata | null>(null);

    // Load session metadata to detect snapshot lock (single_session mode only)
    const internalSessionId = task.internalSessionId || task.sessionId;
    useEffect(() => {
        if (!internalSessionId || task.runMode !== 'single_session') return;
        void (async () => {
            const data = await getSessionDetails(internalSessionId);
            if (isMountedRef.current) setSessionMeta(data);
        })();
    }, [internalSessionId, task.runMode]);

    const canSyncToAgent = !isManagedTask
        && task.runMode === 'single_session'
        && !!project?.agentId
        && !!sessionMeta?.configSnapshotAt;

    // Edit mode
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editName, setEditName] = useState(task.name || '');
    const [editPrompt, setEditPrompt] = useState(task.prompt);
    const [editSchedule, setEditSchedule] = useState<CronSchedule | null>(task.schedule ?? null);
    const [editInterval, setEditInterval] = useState(task.intervalMinutes);
    const [editEndMode, setEditEndMode] = useState<'conditional' | 'forever'>(
        (task.endConditions.deadline || task.endConditions.maxExecutions) ? 'conditional' : 'forever'
    );
    const [editDeadline, setEditDeadline] = useState(task.endConditions.deadline || '');
    const [editMaxExec, setEditMaxExec] = useState(task.endConditions.maxExecutions ? String(task.endConditions.maxExecutions) : '');
    const [editAiCanExit, setEditAiCanExit] = useState(task.endConditions.aiCanExit);
    const [editNotify, setEditNotify] = useState(task.notifyEnabled);
    const [editDeliveryBotId, setEditDeliveryBotId] = useState(task.delivery?.botId ?? '');
    const { options: deliveryOptions, hasChannels, resolveDelivery, getChannelInfo } = useDeliveryChannels(task.workspacePath);
    const isAtSchedule = editSchedule?.kind === 'at';

    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (isEditing) setIsEditing(false); else onClose(); } };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose, isEditing]);

    const startEditing = useCallback(() => {
        setEditName(task.name || ''); setEditPrompt(task.prompt);
        setEditSchedule(task.schedule ?? null); setEditInterval(task.intervalMinutes);
        setEditEndMode((task.endConditions.deadline || task.endConditions.maxExecutions) ? 'conditional' : 'forever');
        setEditDeadline(task.endConditions.deadline || '');
        setEditMaxExec(task.endConditions.maxExecutions ? String(task.endConditions.maxExecutions) : '');
        setEditAiCanExit(task.endConditions.aiCanExit); setEditNotify(task.notifyEnabled);
        setEditDeliveryBotId(task.delivery?.botId ?? '');
        setIsEditing(true);
    }, [task]);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        try {
            const endConditions: CronEndConditions = isAtSchedule ? { aiCanExit: false }
                : editEndMode === 'forever' ? { aiCanExit: editAiCanExit }
                : { deadline: editDeadline ? new Date(editDeadline).toISOString() : undefined, maxExecutions: editMaxExec ? parseInt(editMaxExec, 10) : undefined, aiCanExit: editAiCanExit };
            // Delivery update logic: set if resolved, clear if user chose default, preserve if unchanged
            const deliveryFields: { delivery?: import('@/types/cronTask').CronDelivery; clearDelivery?: boolean } = {};
            if (editDeliveryBotId) {
                const resolved = resolveDelivery(editDeliveryBotId);
                if (resolved) {
                    deliveryFields.delivery = resolved;
                }
                // If channel was removed and can't resolve, don't touch delivery (preserve existing)
            } else {
                // User explicitly selected "桌面通知" (empty value) — clear delivery
                deliveryFields.clearDelivery = true;
            }
            const scheduleFields = editSchedule
                ? {
                    schedule: editSchedule,
                    ...(editSchedule.kind === 'every' ? { intervalMinutes: editSchedule.minutes } : {}),
                }
                : { intervalMinutes: editInterval };
            const updatedTask = await cronClient.updateCronTaskFields(task.id, {
                name: editName.trim() || undefined, prompt: editPrompt.trim(),
                ...scheduleFields,
                endConditions, notifyEnabled: editNotify,
                ...deliveryFields,
            });
            if (!isMountedRef.current) return;
            onUpdated?.(updatedTask);
            toast.success(t('cron.detail.updateSuccess')); onClose(); // Close to refresh — cron:task-updated event triggers parent list reload
        } catch (err) { if (!isMountedRef.current) return; toast.error(t('cron.detail.updateFailed', { message: err instanceof Error ? err.message : String(err) })); }
        finally { if (isMountedRef.current) setIsSaving(false); }
    }, [task.id, editName, editPrompt, editSchedule, editInterval, editEndMode, editDeadline, editMaxExec, editAiCanExit, editNotify, editDeliveryBotId, resolveDelivery, isAtSchedule, toast, onClose, onUpdated, t]);

    const handleDelete = useCallback(async () => {
        setIsDeleting(true); try { await onDelete(task.id); onClose(); } catch { /* caller handles */ } finally { if (isMountedRef.current) { setIsDeleting(false); setShowDeleteConfirm(false); } }
    }, [task.id, onDelete, onClose]);
    const handleResume = useCallback(async () => { setIsResuming(true); try { await onResume(task.id); } finally { if (isMountedRef.current) setIsResuming(false); } }, [task.id, onResume]);
    const handleStop = useCallback(async () => { if (!onStop) return; setIsStopping(true); try { await onStop(task.id); } catch { /* caller handles */ } finally { if (isMountedRef.current) { setIsStopping(false); setShowStopConfirm(false); } } }, [task.id, onStop]);

    // v0.1.69 T16: push session snapshot back to agent (single_session owned sessions only).
    // providerEnvJson is intentionally NOT passed — patchAgentConfig auto-resolves it from the
    // current provider registry + API keys, so a stale-rotated key in the snapshot doesn't
    // overwrite the agent's fresh credentials.
    const handleSyncToAgent = useCallback(async () => {
        if (!sessionMeta || !project?.agentId) return;
        setIsSyncing(true);
        try {
            await patchAgentConfig(
                project.agentId,
                buildAgentPatchFromSessionSnapshot(sessionMeta, agent),
            );
            if (!isMountedRef.current) return;
            toast.success(t('cron.detail.syncSuccess'));
            setShowSyncConfirm(false);
        } catch (err) {
            if (!isMountedRef.current) return;
            toast.error(t('cron.detail.syncFailed', { message: err instanceof Error ? err.message : String(err) }));
        } finally {
            if (isMountedRef.current) setIsSyncing(false);
        }
    }, [agent, sessionMeta, project?.agentId, toast, t]);

    const resumeBlockReason = formatCronResumeBlockReason(task, t);
    const displayName = task.name || task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '...' : '');
    const scheduleDesc = formatCronScheduleDescription(task, t, locale);
    const nextExec = formatCronNextExecution(task.nextExecutionAt, task.status, t, locale);
    const runModeLabel = task.runMode === 'single_session' ? t('cron.detail.runModeSingle') : t('cron.detail.runModeNew');

    const editErrors = useMemo(() => {
        if (!isEditing) return [];
        const errs: string[] = [];
        if (!editPrompt.trim()) errs.push(t('cron.detail.validation.promptRequired'));
        if (!editSchedule && editInterval < MIN_CRON_INTERVAL) errs.push(t('cron.detail.validation.intervalTooShort', { min: MIN_CRON_INTERVAL }));
        return errs;
    }, [isEditing, editPrompt, editSchedule, editInterval, t]);

    return (
        <>
            {showDeleteConfirm && <ConfirmDialog title={t('cron.detail.deleteTitle')} message={t('cron.detail.deleteMessage', { name: displayName })} confirmText={t('cron.detail.deleteConfirm')} cancelText={t('cron.detail.cancelConfirm')} confirmVariant="danger" loading={isDeleting} onConfirm={handleDelete} onCancel={() => setShowDeleteConfirm(false)} />}
            {showStopConfirm && <ConfirmDialog title={t('cron.detail.stopTitle')} message={t('cron.detail.stopMessage', { name: displayName })} confirmText={t('cron.detail.stopConfirm')} cancelText={t('cron.detail.cancelConfirm')} confirmVariant="danger" loading={isStopping} onConfirm={handleStop} onCancel={() => setShowStopConfirm(false)} />}
            {showSyncConfirm && <ConfirmDialog title={t('cron.detail.syncTitle')} message={t('cron.detail.syncMessage')} confirmText={t('cron.detail.syncConfirm')} cancelText={t('cron.detail.cancelConfirm')} loading={isSyncing} onConfirm={handleSyncToAgent} onCancel={() => setShowSyncConfirm(false)} />}

            <OverlayBackdrop onClose={onClose} className="z-50" style={{ animation: 'overlayFadeIn 200ms ease-out' }}>
                <div className="flex h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg"
                    style={{ animation: 'overlayPanelIn 250ms ease-out' }}>

                    {/* Header */}
                    <div className="flex shrink-0 items-center justify-between px-6 py-4">
                        <div className="flex min-w-0 items-center gap-2.5">
                            <Clock className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                            <h3 className="min-w-0 truncate text-lg font-semibold text-[var(--ink)]">
                                {isEditing ? t('cron.detail.editTitle') : displayName}
                            </h3>
                            {!isEditing && <span className={`shrink-0 text-xs font-medium ${getCronStatusColor(task.status)}`}>{formatCronStatusText(task.status, t)}</span>}
                        </div>
                        <button onClick={() => isEditing ? setIsEditing(false) : onClose()} className="ml-2 shrink-0 rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] transition-colors">
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    {/* Body */}
                    <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
                        {isEditing ? (
                            /* ====== EDIT MODE ====== */
                            <>
                                <div>
                                    <SectionHeader icon={FileText}>{t('cron.detail.sectionBasic')}</SectionHeader>
                                    <div className="mt-3 space-y-4">
                                        <div>
                                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink-secondary)]">{t('cron.detail.taskName')}<span className="ml-1 font-normal text-[var(--ink-muted)]">{t('cron.detail.optional')}</span></label>
                                            <input type="text" value={editName} onChange={e => setEditName(e.target.value)} maxLength={50} placeholder={t('cron.detail.namePlaceholder')} className={INPUT_CLS} />
                                        </div>
                                        <div>
                                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink-secondary)]">{t('cron.detail.sectionAiPrompt')}</label>
                                            <textarea value={editPrompt} onChange={e => setEditPrompt(e.target.value)} rows={5} placeholder={t('cron.detail.promptPlaceholder')} className={`${INPUT_CLS} resize-none`} />
                                        </div>
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                <div>
                                    <SectionHeader icon={Clock}>{t('cron.detail.sectionSchedule')}</SectionHeader>
                                    <div className="mt-3"><ScheduleTypeTabs value={editSchedule} intervalMinutes={editInterval} onChange={(s, m) => { setEditSchedule(s); setEditInterval(m); }} /></div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {!isAtSchedule && (
                                    <div>
                                        <SectionHeader icon={Flag}>{t('cron.detail.sectionEndConditions')}</SectionHeader>
                                        <div className="mt-3 space-y-3">
                                            <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
                                                <button type="button" onClick={() => setEditEndMode('forever')} className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-colors ${editEndMode === 'forever' ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}>{t('cron.settingsModal.forever')}</button>
                                                <button type="button" onClick={() => setEditEndMode('conditional')} className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-colors ${editEndMode === 'conditional' ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}>{t('cron.settingsModal.conditional')}</button>
                                            </div>
                                            {editEndMode === 'conditional' && (
                                            <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)]">
                                                <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5" onClick={() => setEditDeadline(editDeadline ? '' : new Date(Date.now() + 86400000).toISOString().slice(0, 16))}>
                                                    <Checkbox checked={!!editDeadline} onChange={v => setEditDeadline(v ? new Date(Date.now() + 86400000).toISOString().slice(0, 16) : '')} label={t('cron.settingsModal.deadline')} />
                                                    <input type="datetime-local" value={editDeadline.slice(0, 16)} onChange={e => setEditDeadline(e.target.value)} onClick={e => e.stopPropagation()}
                                                        className={`w-44 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!editDeadline ? 'opacity-50' : ''}`} />
                                                </div>
                                                <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5" onClick={() => setEditMaxExec(editMaxExec ? '' : '10')}>
                                                    <Checkbox checked={!!editMaxExec} onChange={v => setEditMaxExec(v ? '10' : '')} label={t('cron.settingsModal.maxExecutions')} />
                                                    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                                                        <input type="number" min={1} max={999} value={editMaxExec || 10} onChange={e => setEditMaxExec(e.target.value)}
                                                            className={`w-16 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-center text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!editMaxExec ? 'opacity-50' : ''}`} />
                                                        <span className={`text-sm text-[var(--ink-secondary)] ${!editMaxExec ? 'opacity-50' : ''}`}>{t('cron.settingsModal.timesSuffix')}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            )}

                                            {/* AI 自主结束 — 在永久运行和条件停止模式下都显示 */}
                                            <div className="flex cursor-pointer items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5" onClick={() => setEditAiCanExit(!editAiCanExit)}>
                                                <Checkbox checked={editAiCanExit} onChange={setEditAiCanExit} label={t('cron.settingsModal.aiCanExit')} />
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* 任务通知 */}
                                <div>
                                    <SectionHeader icon={Bell}>{t('cron.detail.sectionNotifications')}</SectionHeader>
                                    <div className="mt-2 space-y-3">
                                        <div className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                                            <span className="text-sm text-[var(--ink)]">{t('cron.settingsModal.notifyOnCompletion')}</span>
                                            <ToggleSwitch enabled={editNotify} onChange={setEditNotify} />
                                        </div>
                                        {editNotify && hasChannels && (
                                            <div className="space-y-2">
                                                <label className="text-sm font-medium text-[var(--ink)]">{t('cron.settingsModal.deliveryChannel')}</label>
                                                <CustomSelect value={editDeliveryBotId} options={deliveryOptions} onChange={setEditDeliveryBotId} placeholder={t('cron.settingsModal.desktopDefault')} />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </>
                        ) : (
                            /* ====== DETAIL MODE ====== */
                            <>
                                {/* 基本信息 — compact left-right rows */}
                                <div>
                                    <SectionHeader icon={FolderOpen}>{t('cron.detail.sectionBasic')}</SectionHeader>
                                    <div className="mt-2 space-y-1.5">
                                        <div className="flex items-center justify-between py-1">
                                            <span className="text-sm text-[var(--ink-muted)]">{t('cron.detail.taskName')}</span>
                                            <span className="text-sm text-[var(--ink)]">{displayName}</span>
                                        </div>
                                        <div className="flex items-center justify-between py-1">
                                            <span className="text-sm text-[var(--ink-muted)]">{t('cron.detail.executeAgent')}</span>
                                            <div className="flex items-center gap-1.5">
                                                <WorkspaceIcon icon={project?.icon} size={14} />
                                                <span className="text-sm text-[var(--ink)]">{getFolderName(task.workspacePath)}</span>
                                            </div>
                                        </div>
                                        {botInfo && (
                                            <div className="flex items-center justify-between py-1">
                                                <span className="text-sm text-[var(--ink-muted)]">{t('cron.detail.source')}</span>
                                                <span className="text-sm text-[var(--ink)]">{botInfo.name} ({botInfo.platform})</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* AI 指令 */}
                                {task.prompt && (
                                    <>
                                        <div>
                                            <SectionHeader icon={FileText}>{t('cron.detail.sectionAiPrompt')}</SectionHeader>
                                            <div className="mt-2 rounded-lg border border-[var(--line)] px-3.5 py-3 text-sm leading-relaxed text-[var(--ink-secondary)] whitespace-pre-wrap break-words">{task.prompt}</div>
                                        </div>
                                        <div className="border-t border-[var(--line)]" />
                                    </>
                                )}

                                {/* 执行模式 */}
                                <div>
                                    <SectionHeader icon={MessageSquare}>{t('cron.detail.sectionRunMode')}</SectionHeader>
                                    <p className="mt-2 text-sm text-[var(--ink)]">{runModeLabel}</p>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 执行计划 */}
                                <div>
                                    <SectionHeader icon={Clock}>{t('cron.detail.sectionSchedule')}</SectionHeader>
                                    <div className="mt-2 flex items-center justify-between rounded-lg border border-[var(--line)] px-3.5 py-3">
                                        <span className="text-sm font-medium text-[var(--ink)]">{scheduleDesc}</span>
                                        <span className={`text-xs ${task.status === 'running' ? 'text-[var(--ink-secondary)]' : 'text-[var(--ink-muted)]/50'}`}>
                                            {task.status === 'running' ? t('cron.detail.next', { time: nextExec }) : t('cron.detail.stopped')}
                                        </span>
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 结束条件 */}
                                <div>
                                    <SectionHeader icon={Flag}>{t('cron.detail.sectionEndConditions')}</SectionHeader>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <DetailTag label={task.endConditions.deadline ? t('cron.detail.deadline', { time: new Date(task.endConditions.deadline).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }) : t('cron.detail.noDeadline')} />
                                        <DetailTag label={task.endConditions.maxExecutions ? t('cron.detail.maxExecutions', { count: task.endConditions.maxExecutions }) : t('cron.detail.unlimited')} />
                                        <DetailTag label={task.endConditions.aiCanExit ? t('cron.detail.aiCanExit') : t('cron.detail.aiCannotExit')} />
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 任务通知 */}
                                <div>
                                    <SectionHeader icon={Bell}>{t('cron.detail.sectionNotifications')}</SectionHeader>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <DetailTag label={task.notifyEnabled ? t('cron.detail.notificationOn') : t('cron.detail.notificationOff')} />
                                        {(() => {
                                            if (!task.delivery) return <DetailTag label={t('cron.detail.desktopNotification')} />;
                                            const info = getChannelInfo(task.delivery.botId);
                                            if (!info) return <DetailTag label={t('cron.detail.removedChannel', { id: task.delivery.botId })} />;
                                            return <DetailTag label={`${info.agentName}: ${info.name}`} />;
                                        })()}
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 运行统计 */}
                                <div>
                                    <SectionHeader icon={BarChart2}>{t('cron.detail.sectionStats')}</SectionHeader>
                                    <div className="mt-2 grid grid-cols-3 gap-3">
                                        <div>
                                            <span className="text-xs text-[var(--ink-muted)]">{t('cron.detail.executionCount')}</span>
                                            <p className="mt-0.5 text-sm font-medium text-[var(--ink)]">{task.endConditions.maxExecutions ? `${task.executionCount} / ${task.endConditions.maxExecutions}` : t('cron.detail.executionCountValue', { count: task.executionCount })}</p>
                                        </div>
                                        <div>
                                            <span className="text-xs text-[var(--ink-muted)]">{t('cron.detail.lastRun')}</span>
                                            <p className="mt-0.5 text-sm font-medium text-[var(--ink)]">{task.lastExecutedAt ? new Date(task.lastExecutedAt).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</p>
                                        </div>
                                        {task.exitReason && (
                                            <div>
                                                <span className="text-xs text-[var(--ink-muted)]">{t('cron.detail.exitReason')}</span>
                                                <p className="mt-0.5 text-sm font-medium text-[var(--ink)]">{task.exitReason}</p>
                                            </div>
                                        )}
                                    </div>
                                    {task.lastError && <p className="mt-2 text-xs text-[var(--error)]">{task.lastError}</p>}
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {!isManagedTask && (
                                    <div>
                                        <SectionHeader icon={History}>{t('cron.detail.sectionHistory')}</SectionHeader>
                                        <div className="mt-2"><TaskRunHistory taskId={task.id} sessionId={task.internalSessionId || task.sessionId} onOpenSession={onOpenSession ? (sid) => { onOpenSession(sid); onClose(); } : undefined} /></div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-6 py-3.5">
                        {isEditing ? (
                            <>
                                {editErrors.length > 0 ? <p className="text-xs text-[var(--error)]">{editErrors[0]}</p> : <div />}
                                <div className="flex items-center gap-2.5">
                                    <button onClick={() => setIsEditing(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors">{t('cron.detail.cancel')}</button>
                                    <button onClick={handleSave} disabled={editErrors.length > 0 || isSaving}
                                        className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-[var(--on-accent)] transition hover:bg-[var(--accent-warm-hover)] disabled:opacity-50 disabled:cursor-not-allowed">
                                        {isSaving ? t('cron.detail.saving') : t('cron.detail.save')}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                {isManagedTask ? <div /> : (
                                    <button onClick={() => setShowDeleteConfirm(true)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--error)] hover:bg-[var(--error-bg)] transition-colors">
                                        <Trash2 className="h-3.5 w-3.5" />{t('cron.detail.delete')}
                                    </button>
                                )}
                                <div className="flex items-center gap-2.5">
                                    {canSyncToAgent && (
                                        <button
                                            onClick={() => setShowSyncConfirm(true)}
                                            title={t('cron.detail.syncTooltip')}
                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)] transition-colors"
                                        >
                                            <ArrowUpToLine className="h-3.5 w-3.5" />{t('cron.detail.syncToAgent')}
                                        </button>
                                    )}
                                    {!isManagedTask && (
                                        <button onClick={startEditing} className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)] transition-colors">
                                            <Pencil className="h-3.5 w-3.5" />{t('cron.detail.edit')}
                                        </button>
                                    )}
                                    {!isManagedTask && task.status === 'running' && onStop && (
                                        <button onClick={() => setShowStopConfirm(true)} disabled={isStopping}
                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--error)]/30 px-4 py-2 text-sm font-medium text-[var(--error)] hover:bg-[var(--error-bg)] disabled:opacity-50 transition-colors">
                                            <Square className="h-3.5 w-3.5" />{isStopping ? t('cron.detail.stopping') : t('cron.detail.stop')}
                                        </button>
                                    )}
                                    {!isManagedTask && task.status === 'stopped' && (!resumeBlockReason ? (
                                        <button onClick={handleResume} disabled={isResuming}
                                            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-[var(--on-accent)] hover:bg-[var(--accent-warm-hover)] disabled:opacity-50 transition-colors">
                                            <Play className="h-3.5 w-3.5" />{isResuming ? t('cron.detail.resuming') : t('cron.detail.resume')}
                                        </button>
                                    ) : <span className="text-xs text-[var(--ink-muted)]/50">{resumeBlockReason}</span>)}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </OverlayBackdrop>
        </>
    );
}
