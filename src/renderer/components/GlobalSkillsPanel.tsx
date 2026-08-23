/**
 * GlobalSkillsPanel - User-level Skills & Commands management for Settings page
 * Refactored to reuse SkillDetailPanel and CommandDetailPanel for consistent UX
 */
import { Plus, Sparkles, Terminal, Loader2, ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import SkillDetailPanel from './SkillDetailPanel';
import type { SkillDetailPanelRef } from './SkillDetailPanel';
import CommandDetailPanel from './CommandDetailPanel';
import type { CommandDetailPanelRef } from './CommandDetailPanel';
import { CreateDialog, NewSkillChooser, InstallFromUrlDialog, type InstallFromUrlResponse } from './SkillDialogs';
import { SkillCard, CommandCard, SkillIntegrityIssuesPanel } from './SkillsCommandsList';
import type { SkillItem, CommandItem, CapabilityInitialSelect, SkillsListResponse } from '../../shared/skillsTypes';
import type { SkillIntegrityIssue } from '../../shared/skillIntegrity';
import { CUSTOM_EVENTS } from '../../shared/constants';

type ViewState =
    | { type: 'list' }
    | { type: 'skill-detail'; name: string; isNewSkill?: boolean }
    | { type: 'command-detail'; name: string };

/** Map an "open this item" intent to the matching detail ViewState.
 *  Returns null for kinds this panel doesn't handle (e.g. 'agent').
 *  Exhaustive switch — adding a new CapabilityKind triggers a TS error here. */
function viewStateForSelect(select: CapabilityInitialSelect | undefined): ViewState | null {
    if (!select || select.scope !== 'user') return null;
    switch (select.kind) {
        case 'skill': return { type: 'skill-detail', name: select.folderName };
        case 'command': return { type: 'command-detail', name: select.fileName };
        case 'agent': return null;
        default: {
            const _exhaustive: never = select;
            return _exhaustive;
        }
    }
}

export default function GlobalSkillsPanel({
    onDetailChange,
    initialSelect,
}: {
    onDetailChange?: (inDetail: boolean) => void;
    /** When set on first mount, open the matching detail view directly. */
    initialSelect?: CapabilityInitialSelect;
}) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const tRef = useRef(t);
    tRef.current = t;

    // Initialize from initialSelect on first mount; subsequent navigation is user-driven.
    const [viewState, setViewState] = useState<ViewState>(() => viewStateForSelect(initialSelect) ?? { type: 'list' });
    const onDetailChangeRef = useRef(onDetailChange);
    onDetailChangeRef.current = onDetailChange;
    useEffect(() => { onDetailChangeRef.current?.(viewState.type !== 'list'); }, [viewState.type]);
    const [loading, setLoading] = useState(true);
    const [skills, setSkills] = useState<SkillItem[]>([]);
    const [commands, setCommands] = useState<CommandItem[]>([]);
    const [integrityIssues, setIntegrityIssues] = useState<SkillIntegrityIssue[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    // Refs for checking editing state
    const skillDetailRef = useRef<SkillDetailPanelRef>(null);
    const commandDetailRef = useRef<CommandDetailPanelRef>(null);

    // Dialog states
    const [showNewSkillDialog, setShowNewSkillDialog] = useState(false);
    const [showInstallFromUrlDialog, setShowInstallFromUrlDialog] = useState(false);
    const [showNewCommandDialog, setShowNewCommandDialog] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemDescription, setNewItemDescription] = useState('');
    const [creating, setCreating] = useState(false);

    // Sync from Claude Code state
    const [canSyncFromClaude, setCanSyncFromClaude] = useState(false);
    const [syncableCount, setSyncableCount] = useState(0);

    // Track mounted state to prevent setState after unmount
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    // Check if any child is in editing mode
    const isAnyEditing = useCallback(() => {
        if (viewState.type === 'skill-detail' && skillDetailRef.current?.isEditing()) {
            return true;
        }
        if (viewState.type === 'command-detail' && commandDetailRef.current?.isEditing()) {
            return true;
        }
        return false;
    }, [viewState]);

    // Ref-guarded "open this item" effect: navigate to detail when a *new*
    // initialSelect arrives (each OPEN_SETTINGS dispatch is a fresh object,
    // so referential identity discriminates new intents from unrelated
    // re-renders / user-driven back-clicks). Editing-state guard mirrors the
    // back button: never silently discard unsaved edits.
    const lastConsumedSelectRef = useRef<CapabilityInitialSelect | undefined>(initialSelect);
    const isAnyEditingRef = useRef(isAnyEditing);
    isAnyEditingRef.current = isAnyEditing;
    useEffect(() => {
        if (initialSelect === lastConsumedSelectRef.current) return;
        lastConsumedSelectRef.current = initialSelect;
        const next = viewStateForSelect(initialSelect);
        if (!next) return;
        if (isAnyEditingRef.current()) {
            toastRef.current.warning(tRef.current('agentSettings.panel.unsavedWarning'));
            return;
        }
        setViewState(next);
    }, [initialSelect]);

    // Load skills and commands
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [skillsRes, commandsRes, syncCheckRes] = await Promise.all([
                apiGetJson<SkillsListResponse>('/api/skills?scope=user'),
                apiGetJson<{ success: boolean; commands: CommandItem[] }>('/api/command-items?scope=user'),
                apiGetJson<{ canSync: boolean; count: number; folders: string[] }>('/api/skill/sync-check')
            ]);

            // Guard against setState after unmount
            if (!isMountedRef.current) return;

            if (skillsRes.success) {
                setSkills(skillsRes.skills);
                setIntegrityIssues(skillsRes.integrityIssues ?? []);
            }
            if (commandsRes.success) setCommands(commandsRes.commands);

            // Update sync state (with defensive checks for API errors)
            setCanSyncFromClaude(syncCheckRes?.canSync ?? false);
            setSyncableCount(syncCheckRes?.count ?? 0);
        } catch {
            if (!isMountedRef.current) return;
            toastRef.current.error(tRef.current('agentSettings.common.loadFailed'));
        } finally {
            if (isMountedRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);

    const handleBackToList = useCallback(() => {
        if (isAnyEditing()) {
            toastRef.current.warning(tRef.current('agentSettings.panel.unsavedWarning'));
            return;
        }
        setViewState({ type: 'list' });
    }, [isAnyEditing]);


    // 快速创建技能并进入编辑模式
    const handleQuickCreateSkill = useCallback(async (tempName: string) => {
        try {
            const response = await apiPostJson<{ success: boolean; error?: string; folderName?: string }>('/api/skill/create', {
                name: tempName,
                scope: 'user',
                description: ''
            });
            if (response.success) {
                // 使用返回的 folderName（sanitized）而非 tempName
                setViewState({ type: 'skill-detail', name: response.folderName || tempName, isNewSkill: true });
                setRefreshKey(k => k + 1);
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
            } else {
                toastRef.current.error(response.error || tRef.current('agentSettings.common.createFailed'));
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.common.createFailed'));
        }
    }, []);

    // 从 Claude Code 同步技能
    const handleSyncFromClaude = useCallback(async () => {
        try {
            const response = await apiPostJson<{
                success: boolean;
                synced: number;
                failed: number;
                errors?: string[];
            }>('/api/skill/sync-from-claude', {});

            if (response.success) {
                if (response.failed > 0) {
                    toastRef.current.warning(tRef.current('agentSettings.skillCommandList.syncPartial', { synced: response.synced, failed: response.failed }));
                } else if (response.synced > 0) {
                    toastRef.current.success(tRef.current('agentSettings.skillCommandList.syncSuccess', { count: response.synced }));
                } else {
                    toastRef.current.info(tRef.current('agentSettings.skillCommandList.noSyncableSkills'));
                }
                setShowNewSkillDialog(false);
                setRefreshKey(k => k + 1);
                if (response.synced > 0) {
                    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
                }
            } else {
                toastRef.current.error(tRef.current('agentSettings.skillCommandList.syncFailed'));
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.skillCommandList.syncFailed'));
        }
    }, []);

    // 上传技能文件
    const handleUploadSkill = useCallback(async (file: File) => {
        try {
            const reader = new FileReader();
            reader.onload = async () => {
                const base64Content = (reader.result as string).split(',')[1];
                try {
                    const response = await apiPostJson<{
                        success: boolean;
                        folderName?: string;
                        message?: string;
                        error?: string;
                    }>('/api/skill/upload', {
                        filename: file.name,
                        content: base64Content,
                        scope: 'user'
                    });

                    if (response.success) {
                        toastRef.current.success(response.folderName
                            ? tRef.current('agentSettings.skillCommandList.skillImportSuccessNamed', { name: response.folderName })
                            : tRef.current('agentSettings.skillCommandList.skillImportSuccess'));
                        setShowNewSkillDialog(false);
                        setRefreshKey(k => k + 1);
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
                        if (response.folderName) {
                            setViewState({ type: 'skill-detail', name: response.folderName });
                        }
                    } else {
                        toastRef.current.error(response.error || tRef.current('agentSettings.common.importFailed'));
                    }
                } catch (err) {
                    toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.importFailed'));
                }
            };
            reader.onerror = () => toastRef.current.error(tRef.current('agentSettings.common.readFileFailed'));
            reader.readAsDataURL(file);
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.uploadFailed'));
        }
    }, []);

    // 从 URL 安装 skill — probe + optional confirm，内部无状态，由 Dialog 负责两次请求
    const handleInstallFromUrl = useCallback(
        async (
            url: string,
            confirmedSelection?: { pluginName?: string; folderNames?: string[]; overwrite?: string[] },
        ): Promise<InstallFromUrlResponse> => {
            return apiPostJson<InstallFromUrlResponse>('/api/skill/install-from-url', {
                url,
                scope: 'user',
                confirmedSelection,
            });
        },
        [],
    );

    // 导入文件夹
    const handleImportFolder = useCallback(async (folderPath: string) => {
        try {
            const response = await apiPostJson<{
                success: boolean;
                folderName?: string;
                message?: string;
                error?: string;
            }>('/api/skill/import-folder', {
                folderPath,
                scope: 'user'
            });

            if (response.success) {
                toastRef.current.success(response.folderName
                    ? tRef.current('agentSettings.skillCommandList.skillImportSuccessNamed', { name: response.folderName })
                    : tRef.current('agentSettings.skillCommandList.skillImportSuccess'));
                setShowNewSkillDialog(false);
                setRefreshKey(k => k + 1);
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
                if (response.folderName) {
                    setViewState({ type: 'skill-detail', name: response.folderName });
                }
            } else {
                toastRef.current.error(response.error || tRef.current('agentSettings.common.importFailed'));
            }
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.importFailed'));
        }
    }, []);

    const handleCreateCommand = useCallback(async () => {
        if (!newItemName.trim()) return;
        setCreating(true);
        try {
            const response = await apiPostJson<{ success: boolean; error?: string }>('/api/command-item/create', {
                name: newItemName.trim(),
                scope: 'user',
                description: newItemDescription.trim() || undefined
            });
            if (response.success) {
                toastRef.current.success(tRef.current('agentSettings.skillCommandList.commandCreateSuccess'));
                setShowNewCommandDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                setRefreshKey(k => k + 1);
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
            } else {
                toastRef.current.error(response.error || tRef.current('agentSettings.common.createFailed'));
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.common.createFailed'));
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription]);

    // Toggle skill enable/disable state
    const handleToggleEnabled = useCallback(async (folderName: string, enabled: boolean) => {
        try {
            const res = await apiPostJson<{ success: boolean; error?: string }>('/api/skill/toggle-enable', { folderName, enabled });
            if (res.success) {
                // Update local state for responsive UI
                setSkills(prev => prev.map(s =>
                    s.folderName === folderName ? { ...s, enabled } : s
                ));
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
            } else {
                toastRef.current.error(res.error || tRef.current('agentSettings.common.operationFailed'));
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.common.operationFailed'));
        }
    }, []);

    const handleItemSaved = useCallback((autoClose?: boolean) => {
        setRefreshKey(k => k + 1);
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
        if (autoClose) {
            setViewState({ type: 'list' });
        }
    }, []);

    const handleItemDeleted = useCallback(() => {
        setViewState({ type: 'list' });
        setRefreshKey(k => k + 1);
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
    }, []);

    if (loading && viewState.type === 'list') {
        return (
            <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    // Skill Detail View - Reuse SkillDetailPanel
    if (viewState.type === 'skill-detail') {
        return (
            <div className="space-y-4">
                <button
                    onClick={handleBackToList}
                    className="flex items-center gap-1 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    <ChevronLeft className="h-4 w-4" />
                    {t('agentSettings.panel.backToList')}
                </button>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] overflow-hidden" style={{ minHeight: '500px' }}>
                    <SkillDetailPanel
                        ref={skillDetailRef}
                        name={viewState.name}
                        scope="user"
                        onBack={handleBackToList}
                        onSaved={handleItemSaved}
                        onDeleted={handleItemDeleted}
                        startInEditMode={viewState.isNewSkill}
                    />
                </div>
            </div>
        );
    }

    // Command Detail View - Reuse CommandDetailPanel
    if (viewState.type === 'command-detail') {
        return (
            <div className="space-y-4">
                <button
                    onClick={handleBackToList}
                    className="flex items-center gap-1 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    <ChevronLeft className="h-4 w-4" />
                    {t('agentSettings.panel.backToList')}
                </button>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] overflow-hidden" style={{ minHeight: '400px' }}>
                    <CommandDetailPanel
                        ref={commandDetailRef}
                        name={viewState.name}
                        scope="user"
                        onBack={handleBackToList}
                        onSaved={handleItemSaved}
                        onDeleted={handleItemDeleted}
                    />
                </div>
            </div>
        );
    }

    // List View
    return (
        <div className="space-y-8">
            {/* Skills Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.skillCommandList.userSkillsTitle')}</h3>
                        <span className="text-xs text-[var(--ink-muted)]">({skills.length})</span>
                    </div>
                    <button
                        onClick={() => setShowNewSkillDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        {t('agentSettings.common.new')}
                    </button>
                </div>
                <SkillIntegrityIssuesPanel issues={integrityIssues} />
                {skills.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {skills.map(skill => (
                            <SkillCard
                                key={skill.folderName}
                                skill={skill}
                                onClick={() => setViewState({ type: 'skill-detail', name: skill.folderName })}
                                onToggleEnabled={skill.required ? undefined : handleToggleEnabled}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8 text-center">
                        <Sparkles className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('agentSettings.skillCommandList.emptyUserSkills')}</p>
                    </div>
                )}
            </div>

            {/* Commands Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Terminal className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.skillCommandList.userCommandsTitle')}</h3>
                        <span className="text-xs text-[var(--ink-muted)]">({commands.length})</span>
                    </div>
                    <button
                        onClick={() => setShowNewCommandDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        {t('agentSettings.common.new')}
                    </button>
                </div>
                {commands.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {commands.map(cmd => (
                            <CommandCard
                                key={cmd.fileName}
                                command={cmd}
                                onClick={() => setViewState({ type: 'command-detail', name: cmd.fileName })}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8 text-center">
                        <Terminal className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">{t('agentSettings.skillCommandList.emptyUserCommands')}</p>
                    </div>
                )}
            </div>

            {/* Dialogs */}
            {showNewSkillDialog && (
                <NewSkillChooser
                    onWriteSkill={() => {
                        setShowNewSkillDialog(false);
                        const tempName = `new-skill-${Date.now()}`;
                        handleQuickCreateSkill(tempName);
                    }}
                    onUploadSkill={handleUploadSkill}
                    onImportFolder={handleImportFolder}
                    onInstallFromUrl={() => {
                        setShowNewSkillDialog(false);
                        setShowInstallFromUrlDialog(true);
                    }}
                    onCancel={() => setShowNewSkillDialog(false)}
                    syncConfig={canSyncFromClaude ? {
                        onSync: handleSyncFromClaude,
                        canSync: canSyncFromClaude,
                        syncableCount: syncableCount
                    } : undefined}
                />
            )}
            {showInstallFromUrlDialog && (
                <InstallFromUrlDialog
                    onInstall={handleInstallFromUrl}
                    onCancel={() => setShowInstallFromUrlDialog(false)}
                    onInstalled={(folderNames) => {
                        setShowInstallFromUrlDialog(false);
                        setRefreshKey(k => k + 1);
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
                        if (folderNames.length === 1) {
                            toastRef.current.success(tRef.current('agentSettings.skillCommandList.installedSingle', { name: folderNames[0] }));
                            setViewState({ type: 'skill-detail', name: folderNames[0] });
                        } else {
                            toastRef.current.success(tRef.current('agentSettings.skillCommandList.installedMultiple', { count: folderNames.length }));
                        }
                    }}
                />
            )}
            {showNewCommandDialog && (
                <CreateDialog
                    title={t('agentSettings.skillCommandList.newCommandTitle')}
                    name={newItemName}
                    description={newItemDescription}
                    onNameChange={setNewItemName}
                    onDescriptionChange={setNewItemDescription}
                    onConfirm={handleCreateCommand}
                    onCancel={() => { setShowNewCommandDialog(false); setNewItemName(''); setNewItemDescription(''); }}
                    loading={creating}
                />
            )}

            <p className="text-center text-xs text-[var(--ink-muted)]">
                {t('agentSettings.skillCommandList.userStorageHint')}
            </p>
        </div>
    );
}
