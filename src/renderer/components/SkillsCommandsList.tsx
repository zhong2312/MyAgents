/**
 * SkillsCommandsList - Component for displaying Skills and Commands list
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalSkillsPanel in Settings).
 */
import { FolderOpen, Loader2, Plus, ShieldAlert, Sparkles, Terminal } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGetJson as globalApiGet, apiPostJson as globalApiPost, apiDelete as globalApiDelete } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import { CreateDialog, NewSkillChooser, InstallFromUrlDialog, type InstallFromUrlResponse } from './SkillDialogs';
import type { SkillItem, CommandItem, SkillsListResponse } from '../../shared/skillsTypes';
import type { SkillIntegrityIssue } from '../../shared/skillIntegrity';
import { CUSTOM_EVENTS } from '../../shared/constants';

interface SkillsCommandsListProps {
    scope: 'user' | 'project';
    agentDir?: string;
    onSelectSkill: (name: string, scope: 'user' | 'project', isNewSkill?: boolean) => void;
    onSelectCommand: (name: string, scope: 'user' | 'project') => void;
    refreshKey?: number;
}

export default function SkillsCommandsList({
    scope,
    agentDir,
    onSelectSkill,
    onSelectCommand,
    refreshKey = 0,
}: SkillsCommandsListProps) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const tRef = useRef(t);
    tRef.current = t;

    // Use Tab-scoped API when available (in project workspace context)
    // Fall back to global API when not in Tab context (Settings page)
    const tabState = useTabApiOptional();

    // Create stable API functions - only depend on the specific functions, not the whole tabState
    // This prevents re-creating the api object when unrelated tabState properties change
    const apiGet = tabState?.apiGet;
    const apiPost = tabState?.apiPost;
    const apiDeleteFn = tabState?.apiDelete;

    const api = useMemo(() => {
        if (apiGet && apiPost && apiDeleteFn) {
            return { get: apiGet, post: apiPost, delete: apiDeleteFn };
        }
        return { get: globalApiGet, post: globalApiPost, delete: globalApiDelete };
    }, [apiGet, apiPost, apiDeleteFn]);

    // Track if we're in tab context (stable boolean that won't change)
    const isInTabContext = !!tabState;
    const [loading, setLoading] = useState(true);
    const [skills, setSkills] = useState<SkillItem[]>([]);
    const [commands, setCommands] = useState<CommandItem[]>([]);
    const [integrityIssues, setIntegrityIssues] = useState<SkillIntegrityIssue[]>([]);
    const [savingCapabilityIds, setSavingCapabilityIds] = useState<Set<string>>(() => new Set());
    const [showNewSkillDialog, setShowNewSkillDialog] = useState(false);
    const [showInstallFromUrlDialog, setShowInstallFromUrlDialog] = useState(false);
    const [showNewCommandDialog, setShowNewCommandDialog] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemDescription, setNewItemDescription] = useState('');
    const [creating, setCreating] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<{ type: 'skill' | 'command'; name: string; scope: 'user' | 'project' } | null>(null);
    const [deleting, setDeleting] = useState(false);

    // Build endpoint with optional agentDir (same pattern as SystemPromptsPanel)
    const buildEndpoint = useCallback((path: string) => {
        if (isInTabContext) return path;
        if (!agentDir) return path;
        const sep = path.includes('?') ? '&' : '?';
        return `${path}${sep}agentDir=${encodeURIComponent(agentDir)}`;
    }, [isInTabContext, agentDir]);

    // Project scope is the effective project view: local plus global
    // candidates after winner resolution and persisted overrides.
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            if (scope === 'project') {
                const response = await api.get<{
                    success: boolean;
                    skills: SkillItem[];
                    commands: CommandItem[];
                    integrityIssues?: SkillIntegrityIssue[];
                }>(buildEndpoint('/api/project-capabilities'));
                if (response.success) {
                    setSkills(response.skills);
                    setCommands(response.commands);
                    setIntegrityIssues(response.integrityIssues ?? []);
                }
            } else {
                const [skillsRes, commandsRes] = await Promise.all([
                    api.get<SkillsListResponse>(buildEndpoint(`/api/skills?scope=${scope}`)),
                    api.get<{ success: boolean; commands: CommandItem[] }>(buildEndpoint(`/api/command-items?scope=${scope}`)),
                ]);
                if (skillsRes.success) {
                    setSkills(skillsRes.skills);
                    setIntegrityIssues(skillsRes.integrityIssues ?? []);
                }
                if (commandsRes.success) setCommands(commandsRes.commands);
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.common.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [scope, api, buildEndpoint]);

    const handleProjectCapabilityToggle = useCallback(async (capabilityId: string, enabled: boolean) => {
        if (scope !== 'project' || savingCapabilityIds.size > 0) return;
        const previousSkills = skills;
        const previousCommands = commands;
        setSkills(current => current.map(item => item.capabilityId === capabilityId ? { ...item, enabled } : item));
        setCommands(current => current.map(item => item.capabilityId === capabilityId ? { ...item, enabled } : item));
        setSavingCapabilityIds(current => new Set(current).add(capabilityId));
        try {
            const response = await api.post<{
                success: boolean;
                error?: string;
                skills?: SkillItem[];
                commands?: CommandItem[];
                integrityIssues?: SkillIntegrityIssue[];
            }>('/api/project-capability/toggle', {
                capabilityId,
                enabled,
                ...(!isInTabContext && agentDir ? { agentDir } : {}),
            });
            if (!response.success || !response.skills || !response.commands) {
                throw new Error(response.error || tRef.current('agentSettings.common.saveFailed'));
            }
            setSkills(response.skills);
            setCommands(response.commands);
            setIntegrityIssues(response.integrityIssues ?? []);
            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
        } catch (error) {
            // Roll back synchronously to the last authoritative response. A
            // best-effort refresh follows, but a second network failure must
            // never leave the optimistic value looking committed.
            setSkills(previousSkills);
            setCommands(previousCommands);
            void loadData();
            toastRef.current.error(error instanceof Error ? error.message : tRef.current('agentSettings.common.saveFailed'));
        } finally {
            setSavingCapabilityIds(current => {
                const next = new Set(current);
                next.delete(capabilityId);
                return next;
            });
        }
    }, [agentDir, api, commands, isInTabContext, loadData, savingCapabilityIds.size, scope, skills]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);


    // 快速创建技能并立即进入编辑模式
    const handleQuickCreateSkill = useCallback(async (tempName: string) => {
        try {
            // When using Tab API, no need to pass agentDir (sidecar already has it)
            // When using global API, pass agentDir for project scope
            const payload = isInTabContext
                ? { name: tempName, scope, description: '' }
                : { name: tempName, scope, description: '', ...(scope === 'project' && agentDir ? { agentDir } : {}) };

            const response = await api.post<{ success: boolean; error?: string; folderName?: string }>('/api/skill/create', payload);
            if (response.success) {
                // 创建成功后直接进入详情页(编辑模式由详情页处理)
                // 使用返回的 folderName（sanitized）而非 tempName
                onSelectSkill(response.folderName || tempName, scope, true);
                loadData();
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
            } else {
                toastRef.current.error(response.error || tRef.current('agentSettings.common.createFailed'));
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.common.createFailed'));
        }
    }, [scope, agentDir, loadData, onSelectSkill, api, isInTabContext]);

    // 上传技能文件
    const handleUploadSkill = useCallback(async (file: File) => {
        try {
            // 读取文件为 base64
            const reader = new FileReader();
            reader.onload = async () => {
                const base64Content = (reader.result as string).split(',')[1]; // 去除 data:xxx;base64, 前缀
                try {
                    const response = await api.post<{
                        success: boolean;
                        folderName?: string;
                        message?: string;
                        error?: string;
                    }>('/api/skill/upload', {
                        filename: file.name,
                        content: base64Content,
                        scope
                    });

                    if (response.success) {
                        toastRef.current.success(response.folderName
                            ? tRef.current('agentSettings.skillCommandList.skillImportSuccessNamed', { name: response.folderName })
                            : tRef.current('agentSettings.skillCommandList.skillImportSuccess'));
                        setShowNewSkillDialog(false);
                        loadData();
                        // 进入新创建的技能详情页
                        if (response.folderName) {
                            onSelectSkill(response.folderName, scope, true);
                        }
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
                    } else {
                        toastRef.current.error(response.error || tRef.current('agentSettings.common.importFailed'));
                    }
                } catch (err) {
                    toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.importFailed'));
                }
            };
            reader.onerror = () => {
                toastRef.current.error(tRef.current('agentSettings.common.readFileFailed'));
            };
            reader.readAsDataURL(file);
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.uploadFailed'));
        }
    }, [scope, loadData, onSelectSkill, api]);

    // 从 URL 安装 skill — 走 Tab-scoped API，scope 来自 props，
    // 所以工作区入口会装到 <workspace>/.claude/skills/ 而不是全局 ~/.myagents/skills/
    const handleInstallFromUrl = useCallback(
        async (
            url: string,
            confirmedSelection?: { pluginName?: string; folderNames?: string[]; overwrite?: string[] },
        ): Promise<InstallFromUrlResponse> => {
            return api.post<InstallFromUrlResponse>('/api/skill/install-from-url', {
                url,
                scope,
                confirmedSelection,
            });
        },
        [api, scope],
    );

    // 导入文件夹
    const handleImportFolder = useCallback(async (folderPath: string) => {
        try {
            const response = await api.post<{
                success: boolean;
                folderName?: string;
                message?: string;
                error?: string;
            }>('/api/skill/import-folder', {
                folderPath,
                scope
            });

            if (response.success) {
                toastRef.current.success(response.folderName
                    ? tRef.current('agentSettings.skillCommandList.skillImportSuccessNamed', { name: response.folderName })
                    : tRef.current('agentSettings.skillCommandList.skillImportSuccess'));
                setShowNewSkillDialog(false);
                loadData();
                // 进入新创建的技能详情页
                if (response.folderName) {
                    onSelectSkill(response.folderName, scope, true);
                }
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
            } else {
                toastRef.current.error(response.error || tRef.current('agentSettings.common.importFailed'));
            }
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.importFailed'));
        }
    }, [scope, loadData, onSelectSkill, api]);

    const handleCreateCommand = useCallback(async () => {
        if (!newItemName.trim()) return;
        setCreating(true);
        try {
            const response = await api.post<{ success: boolean; error?: string }>('/api/command-item/create', {
                name: newItemName.trim(),
                scope,
                description: newItemDescription.trim() || undefined
            });
            if (response.success) {
                toastRef.current.success(tRef.current('agentSettings.skillCommandList.commandCreateSuccess'));
                setShowNewCommandDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                loadData();
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
            } else {
                toastRef.current.error(response.error || tRef.current('agentSettings.common.createFailed'));
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.common.createFailed'));
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription, scope, loadData, api]);

    const handleDelete = useCallback(async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const endpoint = buildEndpoint(
                deleteTarget.type === 'skill'
                    ? `/api/skill/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`
                    : `/api/command-item/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`
            );

            const response = await api.delete<{ success: boolean; error?: string }>(endpoint);
            if (response.success) {
                toastRef.current.success(tRef.current('agentSettings.common.deleteSuccess'));
                setDeleteTarget(null);
                loadData();
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
            } else {
                toastRef.current.error(response.error || tRef.current('agentSettings.common.deleteFailed'));
            }
        } catch {
            toastRef.current.error(tRef.current('agentSettings.common.deleteFailed'));
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, loadData, api, buildEndpoint]);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    return (
        <div className="p-6">
            {/* Skills Section */}
            <div className="mb-8">
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">
                            {scope === 'project' ? t('agentSettings.skillCommandList.projectSkillsTitle') : t('agentSettings.skillCommandList.skillsTitle')}
                        </h3>
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {scope === 'project'
                                ? t('agentSettings.skillCommandList.enabledCount', { enabled: skills.filter(item => item.enabled).length, total: skills.length })
                                : skills.length}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowNewSkillDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        {t('agentSettings.common.new')}
                    </button>
                </div>

                <SkillIntegrityIssuesPanel issues={integrityIssues} />

                {/* Skills List */}
                {skills.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {skills.map(skill => (
                            <SkillCard
                                key={`${skill.scope}-${skill.folderName}`}
                                skill={skill}
                                onClick={() => onSelectSkill(skill.folderName, skill.scope)}
                                onToggleEnabled={scope === 'project' && skill.capabilityId && !skill.required
                                    ? handleProjectCapabilityToggle
                                    : undefined}
                                saving={savingCapabilityIds.size > 0}
                            />
                        ))}
                    </div>
                ) : (
                    <EmptyState
                        icon={<Sparkles className="h-12 w-12" />}
                        title={scope === 'project' ? t('agentSettings.skillCommandList.emptyProjectSkills') : t('agentSettings.skillCommandList.emptySkills')}
                        description={t('agentSettings.skillCommandList.emptySkillsDescription')}
                    />
                )}

            </div>

            {/* Commands Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Terminal className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">
                            {scope === 'project' ? t('agentSettings.skillCommandList.projectCommandsTitle') : t('agentSettings.skillCommandList.commandsTitle')}
                        </h3>
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {scope === 'project'
                                ? t('agentSettings.skillCommandList.enabledCount', { enabled: commands.filter(item => item.enabled !== false).length, total: commands.length })
                                : commands.length}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowNewCommandDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        {t('agentSettings.common.new')}
                    </button>
                </div>

                {/* Commands List */}
                {commands.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {commands.map(cmd => (
                            <CommandCard
                                key={`${cmd.scope}-${cmd.fileName}`}
                                command={cmd}
                                onClick={() => onSelectCommand(cmd.fileName, cmd.scope)}
                                onToggleEnabled={scope === 'project' && cmd.capabilityId
                                    ? handleProjectCapabilityToggle
                                    : undefined}
                                saving={savingCapabilityIds.size > 0}
                            />
                        ))}
                    </div>
                ) : (
                    <EmptyState
                        icon={<Terminal className="h-12 w-12" />}
                        title={scope === 'project' ? t('agentSettings.skillCommandList.emptyProjectCommands') : t('agentSettings.skillCommandList.emptyCommands')}
                        description={t('agentSettings.skillCommandList.emptyCommandsDescription')}
                    />
                )}

            </div>

            {/* New Skill Dialog - Choice Mode */}
            {showNewSkillDialog && (
                <NewSkillChooser
                    onWriteSkill={() => {
                        // 直接进入编辑模式创建新技能
                        setShowNewSkillDialog(false);
                        // 创建临时技能并进入编辑模式
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
                />
            )}

            {/* Install from URL Dialog */}
            {showInstallFromUrlDialog && (
                <InstallFromUrlDialog
                    onInstall={handleInstallFromUrl}
                    onCancel={() => setShowInstallFromUrlDialog(false)}
                    onInstalled={(folderNames) => {
                        setShowInstallFromUrlDialog(false);
                        loadData();
                        if (folderNames.length === 1) {
                            toastRef.current.success(tRef.current('agentSettings.skillCommandList.installedSingle', { name: folderNames[0] }));
                            onSelectSkill(folderNames[0], scope, true);
                        } else {
                            toastRef.current.success(tRef.current('agentSettings.skillCommandList.installedMultiple', { count: folderNames.length }));
                        }
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.PROJECT_CAPABILITIES_CHANGED));
                    }}
                />
            )}

            {/* New Command Dialog */}
            {showNewCommandDialog && (
                <CreateDialog
                    title={t('agentSettings.skillCommandList.newCommandTitle')}
                    name={newItemName}
                    description={newItemDescription}
                    onNameChange={setNewItemName}
                    onDescriptionChange={setNewItemDescription}
                    onConfirm={handleCreateCommand}
                    onCancel={() => {
                        setShowNewCommandDialog(false);
                        setNewItemName('');
                        setNewItemDescription('');
                    }}
                    loading={creating}
                />
            )}

            {/* Delete Confirmation */}
            {deleteTarget && (
                <ConfirmDialog
                    title={deleteTarget.type === 'skill' ? t('agentSettings.skillCommandList.deleteSkillTitle') : t('agentSettings.skillCommandList.deleteCommandTitle')}
                    message={t('agentSettings.skillCommandList.deleteMessage', { name: deleteTarget.name })}
                    confirmText={t('agentSettings.common.delete')}
                    confirmVariant="danger"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleteTarget(null)}
                    loading={deleting}
                />
            )}
        </div>
    );
}

export function SkillIntegrityIssuesPanel({ issues }: { issues: readonly SkillIntegrityIssue[] }) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    if (issues.length === 0) return null;

    const reveal = async (path: string) => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('cmd_open_path_external', { fullPath: path, workspace: null });
        } catch {
            toast.error(t('agentSettings.skillCommandList.integrityRevealFailed'));
        }
    };

    return (
        <div className="mb-4 space-y-2" aria-label={t('agentSettings.skillCommandList.integrityTitle')}>
            {issues.map((issue) => {
                const blocked = issue.severity === 'blocked';
                return (
                    <div
                        key={`${issue.folderName}-${issue.reason}`}
                        className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 ${blocked
                            ? 'border-red-500/25 bg-red-500/5'
                            : 'border-amber-500/25 bg-amber-500/5'}`}
                    >
                        <ShieldAlert className={`mt-0.5 h-4 w-4 shrink-0 ${blocked ? 'text-red-500' : 'text-amber-500'}`} />
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-[var(--ink)]">{issue.folderName}</span>
                                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${blocked
                                    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}
                                >
                                    {t(`agentSettings.skillCommandList.integrity${blocked ? 'Blocked' : 'Warning'}`)}
                                </span>
                            </div>
                            <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
                                {t(`agentSettings.skillCommandList.integrityReasons.${issue.reason}`)}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void reveal(issue.revealPath)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                            <FolderOpen className="h-3.5 w-3.5" />
                            {t('agentSettings.skillCommandList.integrityReveal')}
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

// Skill Card Component — V2 "compact" layout (v0.1.69 polish):
//   • padding trimmed to px-3.5 py-3 (from p-4)
//   • title 14px (from 15px)
//   • type icon leads the title; author stays adjacent as quiet metadata
//   • scope/system state and the toggle remain right-aligned
//   • description block keeps line-clamp-2 with a min-h reserve so cards in
//     the same row stay the same height regardless of desc length
// Exported for reuse in GlobalSkillsPanel.
export function SkillCard({ skill, onClick, onToggleEnabled, saving = false }: {
    skill: SkillItem;
    onClick: () => void;
    onToggleEnabled?: (id: string, enabled: boolean) => void;
    saving?: boolean;
}) {
    const { t } = useTranslation('settings');
    const isDisabled = skill.enabled === false;
    return (
        <div
            className={`group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 transition-shadow hover:shadow-sm ${isDisabled ? 'opacity-55' : ''}`}
            onClick={onClick}
        >
            {/* Top row — type identity on the left, state and controls on the right. */}
            <div className="flex items-center gap-2">
                <Sparkles data-capability-type-icon="skill" className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <h4 className="min-w-0 truncate text-sm font-semibold text-[var(--ink)]">
                        {skill.name}
                    </h4>
                    {skill.author && (
                        <span data-capability-author className="shrink-0 text-xs text-[var(--ink-muted)]">
                            {skill.author}
                        </span>
                    )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    {skill.origin && (
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {skill.origin === 'global'
                                ? t('agentSettings.capabilities.scopeUser')
                                : t('agentSettings.capabilities.scopeProject')}
                        </span>
                    )}
                    {skill.required && (
                        <span data-capability-system-status className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium tracking-[0.04em] text-[var(--ink-muted)]">
                            {t('agentSettings.skillCommandList.systemRequired')}
                        </span>
                    )}
                    {onToggleEnabled && (
                        <button
                            type="button"
                            role="switch"
                            aria-checked={!isDisabled}
                            aria-label={t('agentSettings.skillCommandList.toggleSkill', { name: skill.name })}
                            aria-busy={saving}
                            disabled={saving}
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleEnabled(skill.capabilityId ?? skill.folderName, isDisabled);
                            }}
                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:cursor-wait ${
                                !isDisabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                            }`}
                        >
                            <span
                                className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${
                                    !isDisabled ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                            />
                        </button>
                    )}
                </div>
            </div>
            {/* Description — `min-h-[2.6em]` reserves the 2-line height even
                for short descriptions so cards in the same grid row align. */}
            <p className="line-clamp-2 min-h-[2.6em] text-sm leading-relaxed text-[var(--ink-muted)]">
                {skill.description || t('agentSettings.common.noDescription')}
            </p>
        </div>
    );
}

// Command Card Component — V2 "compact" layout, same spec as SkillCard
// Exported for reuse in GlobalSkillsPanel.
export function CommandCard({ command, onClick, onToggleEnabled, saving = false }: {
    command: CommandItem;
    onClick: () => void;
    onToggleEnabled?: (id: string, enabled: boolean) => void;
    saving?: boolean;
}) {
    const { t } = useTranslation('settings');
    const isDisabled = command.enabled === false;
    return (
        <div
            className={`group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-3.5 py-3 transition-shadow hover:shadow-sm ${isDisabled ? 'opacity-55' : ''}`}
            onClick={onClick}
        >
            <div className="flex items-center gap-2">
                <Terminal data-capability-type-icon="command" className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <h4 className="min-w-0 truncate text-sm font-semibold text-[var(--ink)]">
                        {command.name}
                    </h4>
                    {command.author && (
                        <span data-capability-author className="shrink-0 text-xs text-[var(--ink-muted)]">
                            {command.author}
                        </span>
                    )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    {command.origin && (
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {command.origin === 'global'
                                ? t('agentSettings.capabilities.scopeUser')
                                : t('agentSettings.capabilities.scopeProject')}
                        </span>
                    )}
                    {onToggleEnabled && (
                        <button
                            type="button"
                            role="switch"
                            aria-checked={!isDisabled}
                            aria-label={t('agentSettings.skillCommandList.toggleCommand', { name: command.name })}
                            aria-busy={saving}
                            disabled={saving}
                            onClick={(event) => {
                                event.stopPropagation();
                                onToggleEnabled(command.capabilityId ?? command.fileName, isDisabled);
                            }}
                            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:cursor-wait ${
                                !isDisabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                            }`}
                        >
                            <span
                                className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${
                                    !isDisabled ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                            />
                        </button>
                    )}
                </div>
            </div>
            <p className="line-clamp-2 min-h-[2.6em] text-sm leading-relaxed text-[var(--ink-muted)]">
                {command.description || t('agentSettings.common.noDescription')}
            </p>
        </div>
    );
}

// Empty State Component
function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
    return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8">
            <div className="text-[var(--ink-muted)]/30">{icon}</div>
            <p className="mt-3 text-sm font-medium text-[var(--ink-muted)]">{title}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">{description}</p>
        </div>
    );
}

// CreateDialog and NewSkillChooser are imported from SkillDialogs.tsx
