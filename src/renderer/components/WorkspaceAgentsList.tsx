/**
 * WorkspaceAgentsList - Project-level agent list with enable/disable toggle
 * Used in WorkspaceConfigPanel's Agents tab
 */
import { Plus, Bot, Loader2, Trash2, X as XIcon, Link2 } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { track } from '@/analytics';
import { apiGetJson as globalApiGet, apiPostJson as globalApiPost, apiPutJson as globalApiPut, apiDelete as globalApiDelete } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { AgentItem, AgentWorkspaceConfig } from '../../shared/agentTypes';

interface WorkspaceAgentsListProps {
    scope: 'user' | 'project';
    agentDir?: string;
    onSelectAgent: (name: string, scope: 'user' | 'project', isNewAgent?: boolean) => void;
    refreshKey?: number;
    onClose?: () => void;
}

export default function WorkspaceAgentsList({
    agentDir,
    onSelectAgent,
    refreshKey = 0,
    onClose: _onClose,
}: WorkspaceAgentsListProps) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const tabState = useTabApiOptional();
    const apiGet = tabState?.apiGet;
    const apiPost = tabState?.apiPost;
    const apiPut = tabState?.apiPut;
    const apiDeleteFn = tabState?.apiDelete;

    const api = useMemo(() => {
        if (apiGet && apiPost && apiPut && apiDeleteFn) {
            return { get: apiGet, post: apiPost, put: apiPut, delete: apiDeleteFn };
        }
        return { get: globalApiGet, post: globalApiPost, put: globalApiPut, delete: globalApiDelete };
    }, [apiGet, apiPost, apiPut, apiDeleteFn]);

    const isInTabContext = !!tabState;

    const [loading, setLoading] = useState(true);
    const [localAgents, setLocalAgents] = useState<AgentItem[]>([]);
    const [globalRefAgents, setGlobalRefAgents] = useState<AgentItem[]>([]);
    const [allGlobalAgents, setAllGlobalAgents] = useState<AgentItem[]>([]);
    const [wsConfig, setWsConfig] = useState<AgentWorkspaceConfig>({ local: {}, global_refs: {} });
    const [showImportPicker, setShowImportPicker] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<{ name: string; type: 'local' | 'global_ref' } | null>(null);
    const [deleting, setDeleting] = useState(false);

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const agentDirParam = (!isInTabContext && agentDir) ? `?agentDir=${encodeURIComponent(agentDir)}` : '';
            const agentDirQs = (!isInTabContext && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';

            const [projectRes, userRes, configRes] = await Promise.all([
                api.get<{ success: boolean; agents: AgentItem[] }>(`/api/agents?scope=project${agentDirQs}`),
                api.get<{ success: boolean; agents: AgentItem[] }>('/api/agents?scope=user'),
                api.get<{ success: boolean; config: AgentWorkspaceConfig }>(`/api/agents/workspace-config${agentDirParam}`),
            ]);

            if (!isMountedRef.current) return;

            if (projectRes.success) setLocalAgents(projectRes.agents);
            if (userRes.success) setAllGlobalAgents(userRes.agents);
            if (configRes.success) {
                setWsConfig(configRes.config);
                // Filter global agents to only show those referenced in workspace config
                if (userRes.success) {
                    const refNames = Object.keys(configRes.config.global_refs || {});
                    setGlobalRefAgents(userRes.agents.filter(a => refNames.includes(a.folderName)));
                }
            }
        } catch {
            if (!isMountedRef.current) return;
            toastRef.current.error(t('agentSettings.workspaceAgents.loadFailed'));
        } finally {
            if (isMountedRef.current) setLoading(false);
        }
    }, [api, isInTabContext, agentDir, t]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);

    const isEnabled = useCallback((folderName: string, type: 'local' | 'global') => {
        if (type === 'local') {
            return wsConfig.local[folderName]?.enabled !== false;
        }
        return wsConfig.global_refs[folderName]?.enabled !== false;
    }, [wsConfig]);

    const updateWsConfig = useCallback(async (newConfig: AgentWorkspaceConfig) => {
        const prevConfig = wsConfig;
        setWsConfig(newConfig);
        try {
            const payload = isInTabContext
                ? { config: newConfig }
                : { config: newConfig, ...(agentDir ? { agentDir } : {}) };
            await api.put<{ success: boolean }>('/api/agents/workspace-config', payload);
        } catch {
            toastRef.current.error(t('agentSettings.workspaceAgents.saveFailed'));
            setWsConfig(prevConfig);
        }
    }, [wsConfig, api, isInTabContext, agentDir, t]);

    const handleToggle = useCallback(async (folderName: string, type: 'local' | 'global', currentEnabled: boolean) => {
        const newConfig = { ...wsConfig };
        if (type === 'local') {
            newConfig.local = { ...newConfig.local, [folderName]: { enabled: !currentEnabled } };
        } else {
            newConfig.global_refs = { ...newConfig.global_refs, [folderName]: { enabled: !currentEnabled } };
        }
        await updateWsConfig(newConfig);
    }, [wsConfig, updateWsConfig]);

    const handleCreateAgent = useCallback(async () => {
        const tempName = `new-agent-${Date.now()}`;
        try {
            const payload = isInTabContext
                ? { name: tempName, scope: 'project' as const, description: '' }
                : { name: tempName, scope: 'project' as const, description: '', ...(agentDir ? { agentDir } : {}) };

            const response = await api.post<{ success: boolean; error?: string; folderName?: string }>('/api/agent/create', payload);
            if (response.success && response.folderName) {
                track('agent_add', { scope: 'project' });
                onSelectAgent(response.folderName, 'project', true);
                loadData();
            } else {
                toastRef.current.error(response.error || t('agentSettings.common.createFailed'));
            }
        } catch {
            toastRef.current.error(t('agentSettings.common.createFailed'));
        }
    }, [api, isInTabContext, agentDir, onSelectAgent, loadData, t]);

    // Import a global agent as a reference
    const handleImportGlobal = useCallback(async (agent: AgentItem) => {
        const newConfig = {
            ...wsConfig,
            global_refs: { ...wsConfig.global_refs, [agent.folderName]: { enabled: true } },
        };
        await updateWsConfig(newConfig);
        setGlobalRefAgents(prev => [...prev, agent]);
        setShowImportPicker(false);
        toastRef.current.success(t('agentSettings.workspaceAgents.imported', { name: agent.name }));
    }, [wsConfig, updateWsConfig, t]);

    // Remove a global reference (doesn't delete the global agent)
    const handleRemoveGlobalRef = useCallback(async (folderName: string) => {
        const newRefs = { ...wsConfig.global_refs };
        delete newRefs[folderName];
        const newConfig = { ...wsConfig, global_refs: newRefs };
        await updateWsConfig(newConfig);
        setGlobalRefAgents(prev => prev.filter(a => a.folderName !== folderName));
        toastRef.current.success(t('agentSettings.workspaceAgents.refRemoved'));
        setDeleteTarget(null);
    }, [wsConfig, updateWsConfig, t]);

    // Delete a local agent (file deletion)
    const handleDeleteLocal = useCallback(async (folderName: string) => {
        setDeleting(true);
        try {
            const agentDirParam = (!isInTabContext && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
            const response = await api.delete<{ success: boolean; error?: string }>(
                `/api/agent/${encodeURIComponent(folderName)}?scope=project${agentDirParam}`
            );
            if (response.success) {
                // Also remove from workspace config
                const newLocal = { ...wsConfig.local };
                delete newLocal[folderName];
                const newConfig = { ...wsConfig, local: newLocal };
                await updateWsConfig(newConfig);
                setLocalAgents(prev => prev.filter(a => a.folderName !== folderName));
                toastRef.current.success(t('agentSettings.common.deleteSuccess'));
            } else {
                toastRef.current.error(response.error || t('agentSettings.common.deleteFailed'));
            }
        } catch {
            toastRef.current.error(t('agentSettings.common.deleteFailed'));
        } finally {
            setDeleting(false);
            setDeleteTarget(null);
        }
    }, [api, isInTabContext, agentDir, wsConfig, updateWsConfig, t]);

    // Available global agents that haven't been imported yet
    const availableForImport = useMemo(() => {
        const refNames = new Set(Object.keys(wsConfig.global_refs || {}));
        return allGlobalAgents.filter(a => !refNames.has(a.folderName));
    }, [allGlobalAgents, wsConfig]);

    if (loading) {
        return (
            <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    const hasAny = localAgents.length > 0 || globalRefAgents.length > 0;

    return (
        <div className="space-y-6 p-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Bot className="h-5 w-5 text-[var(--ink-muted)]" />
                    <h3 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.workspaceAgents.title')}</h3>
                </div>
                <button
                    onClick={handleCreateAgent}
                    className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                >
                    <Plus className="h-4 w-4" />
                    {t('agentSettings.common.new')}
                </button>
            </div>

            {!hasAny && availableForImport.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8 text-center">
                    <Bot className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                    <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('agentSettings.workspaceAgents.emptyTitle')}</p>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                        {t('agentSettings.workspaceAgents.emptyDescription')}
                    </p>
                </div>
            ) : (
                <>
                    {/* Local Agents */}
                    {localAgents.length > 0 && (
                        <div>
                            <h4 className="mb-2 text-sm font-medium text-[var(--ink-muted)]">
                                {t('agentSettings.workspaceAgents.localAgents', { count: localAgents.length })}
                            </h4>
                            <div className="grid grid-cols-2 gap-3">
                                {localAgents.map(agent => (
                                    <AgentRow
                                        key={agent.folderName}
                                        agent={agent}
                                        enabled={isEnabled(agent.folderName, 'local')}
                                        onToggle={() => handleToggle(agent.folderName, 'local', isEnabled(agent.folderName, 'local'))}
                                        onClick={() => onSelectAgent(agent.folderName, 'project')}
                                        onDelete={() => setDeleteTarget({ name: agent.folderName, type: 'local' })}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Global Reference Agents */}
                    {globalRefAgents.length > 0 && (
                        <div>
                            <h4 className="mb-2 text-sm font-medium text-[var(--ink-muted)]">
                                {t('agentSettings.workspaceAgents.globalRefAgents', { count: globalRefAgents.length })}
                            </h4>
                            <div className="grid grid-cols-2 gap-3">
                                {globalRefAgents.map(agent => (
                                    <AgentRow
                                        key={agent.folderName}
                                        agent={agent}
                                        enabled={isEnabled(agent.folderName, 'global')}
                                        onToggle={() => handleToggle(agent.folderName, 'global', isEnabled(agent.folderName, 'global'))}
                                        onClick={() => onSelectAgent(agent.folderName, 'user')}
                                        isGlobalRef
                                        onRemoveRef={() => setDeleteTarget({ name: agent.folderName, type: 'global_ref' })}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Import Global Agent Section */}
                    {availableForImport.length > 0 && (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <h4 className="text-sm font-medium text-[var(--ink-muted)]">{t('agentSettings.workspaceAgents.importGlobalTitle')}</h4>
                                <button
                                    onClick={() => setShowImportPicker(!showImportPicker)}
                                    className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                >
                                    <Link2 className="h-3 w-3" />
                                    {showImportPicker ? t('agentSettings.workspaceAgents.collapse') : t('agentSettings.workspaceAgents.import')}
                                </button>
                            </div>
                            {showImportPicker && (
                                <div className="space-y-1.5 rounded-lg border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 p-3">
                                    {availableForImport.map(agent => (
                                        <div key={agent.folderName} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-[var(--paper-elevated)]">
                                            <div className="min-w-0 flex-1">
                                                <span className="text-sm text-[var(--ink)]">{agent.name}</span>
                                                {agent.description && (
                                                    <p className="truncate text-xs text-[var(--ink-muted)]">{agent.description}</p>
                                                )}
                                            </div>
                                            <button
                                                onClick={() => handleImportGlobal(agent)}
                                                className="ml-2 shrink-0 rounded-md bg-[var(--button-primary-bg)] px-2 py-1 text-xs font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                            >
                                                {t('agentSettings.workspaceAgents.importAction')}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* Delete/Remove Confirmation */}
            {deleteTarget && (
                <ConfirmDialog
                    title={deleteTarget.type === 'local' ? t('agentSettings.workspaceAgents.deleteLocalTitle') : t('agentSettings.workspaceAgents.removeRefTitle')}
                    message={
                        deleteTarget.type === 'local'
                            ? t('agentSettings.workspaceAgents.deleteLocalMessage', { name: deleteTarget.name })
                            : t('agentSettings.workspaceAgents.removeRefMessage', { name: deleteTarget.name })
                    }
                    confirmText={deleteTarget.type === 'local' ? t('agentSettings.common.delete') : t('agentSettings.workspaceAgents.remove')}
                    cancelText={t('agentSettings.common.cancel')}
                    confirmVariant="danger"
                    onConfirm={() => {
                        if (deleteTarget.type === 'local') {
                            handleDeleteLocal(deleteTarget.name);
                        } else {
                            handleRemoveGlobalRef(deleteTarget.name);
                        }
                    }}
                    onCancel={() => setDeleteTarget(null)}
                    loading={deleting}
                />
            )}
        </div>
    );
}

// AgentRow — v0.1.69 polish: migrated from the single-column row layout
// to the V2 "compact card" spec so the Workspace 技能 tab renders Skills /
// Commands / Sub-Agents in one consistent 2-col grid. Matches SkillCard's
// padding (px-3.5 py-3), icon-first identity, title size (14px), inline toggle, and
// `min-h-[2.6em]` description reserve that keeps same-row cards aligned.
//
// Row-specific affordances (delete for local, remove-ref for global) live
// on the title line next to the toggle; they stay hidden until hover so
// the resting state reads clean. Click on the card body opens the detail.
function AgentRow({
    agent,
    enabled,
    onToggle,
    onClick,
    isGlobalRef = false,
    onDelete,
    onRemoveRef,
}: {
    agent: AgentItem;
    enabled: boolean;
    onToggle: () => void;
    onClick: () => void;
    isGlobalRef?: boolean;
    onDelete?: () => void;
    onRemoveRef?: () => void;
}) {
    const { t } = useTranslation('settings');
    return (
        <div
            className={`group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 transition-shadow hover:shadow-sm ${enabled ? '' : 'opacity-55'}`}
            onClick={onClick}
        >
            <div className="flex items-center gap-2">
                <Bot data-capability-type-icon="agent" className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--ink)]">
                    {agent.name}
                </h4>
                {isGlobalRef && (
                    <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-[var(--ink-muted)]">
                        {t('agentSettings.capabilities.scopeUser')}
                    </span>
                )}
                {/* Destructive action — hidden until hover so the resting
                    state matches the cleaner SkillCard / CommandCard. */}
                {isGlobalRef && onRemoveRef && (
                    <button
                        onClick={e => { e.stopPropagation(); onRemoveRef(); }}
                        className="shrink-0 rounded-md p-1 text-[var(--ink-muted)] opacity-0 transition-opacity hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] group-hover:opacity-100"
                        title={t('agentSettings.workspaceAgents.removeRef')}
                    >
                        <XIcon className="h-3.5 w-3.5" />
                    </button>
                )}
                {!isGlobalRef && onDelete && (
                    <button
                        onClick={e => { e.stopPropagation(); onDelete(); }}
                        className="shrink-0 rounded-md p-1 text-[var(--ink-muted)] opacity-0 transition-opacity hover:bg-[var(--error-bg)] hover:text-[var(--error)] group-hover:opacity-100"
                        title={t('agentSettings.common.delete')}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                )}
                <button
                    onClick={e => { e.stopPropagation(); onToggle(); }}
                    className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                        enabled ? 'bg-[var(--accent-warm)]' : 'bg-[var(--ink-muted)]/20'
                    }`}
                >
                    <span
                        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--toggle-thumb)] transition-transform ${
                            enabled ? 'translate-x-4' : ''
                        }`}
                    />
                </button>
            </div>
            <p className="line-clamp-2 min-h-[2.6em] text-sm leading-relaxed text-[var(--ink-muted)]">
                {agent.description || t('agentSettings.common.noDescription')}
            </p>
        </div>
    );
}
