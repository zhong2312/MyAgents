/**
 * SkillDetailPanel - Component for viewing and editing a Skill
 * Supports preview/edit mode with save confirmation
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalSkillsPanel).
 */
import { Save, FolderOpen, Loader2, ChevronDown, ChevronUp, Trash2, Edit2, X, Check } from 'lucide-react';
import { useCallback, useEffect, useState, useImperativeHandle, forwardRef, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGetJson as globalApiGet, apiPutJson as globalApiPut, apiDelete as globalApiDelete, apiPostJson as globalApiPost } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import { Popover } from '@/components/ui/Popover';
import type { SkillFrontmatter, SkillDetail } from '../../shared/skillsTypes';
import { sanitizeFolderName } from '../../shared/utils';
import { shortenPathForDisplay } from '@/utils/pathDetection';

interface SkillDetailPanelProps {
    name: string;
    scope: 'user' | 'project';
    onBack: () => void;
    /** 保存成功回调，autoClose 为 true 时父组件应关闭详情视图 */
    onSaved: (autoClose?: boolean) => void;
    onDeleted: () => void;
    /** 是否在加载完成后自动进入编辑模式，用于新建技能场景 */
    startInEditMode?: boolean;
    /** 项目目录，用于 scope='project' 时的文件操作 */
    agentDir?: string;
}

export interface SkillDetailPanelRef {
    isEditing: () => boolean;
}

const SkillDetailPanel = forwardRef<SkillDetailPanelRef, SkillDetailPanelProps>(
    function SkillDetailPanel({ name, scope, onBack: _onBack, onSaved, onDeleted, startInEditMode = false, agentDir }, ref) {
        const { t } = useTranslation('settings');
        const toast = useToast();
        // Stabilize toast reference to avoid unnecessary effect re-runs
        const toastRef = useRef(toast);
        toastRef.current = toast;
        const tRef = useRef(t);
        tRef.current = t;

        // Use Tab-scoped API when available (in project workspace context)
        const tabState = useTabApiOptional();

        // Create stable API functions - only depend on the specific functions, not the whole tabState
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

        // Track if we're in tab context (stable boolean)
        const isInTabContext = !!tabState;
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [skill, setSkill] = useState<SkillDetail | null>(null);
        const [showAdvanced, setShowAdvanced] = useState(false);
        const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
        const [deleting, setDeleting] = useState(false);
        const [isEditing, setIsEditing] = useState(false);
        // 标记是否是新创建的技能（用于取消时删除）
        const [isNewSkill, setIsNewSkill] = useState(startInEditMode);

        // Original values for comparison (used for cancel/reset)
        const [originalSkillName, setOriginalSkillName] = useState('');
        const [originalDescription, setOriginalDescription] = useState('');
        const [originalBody, setOriginalBody] = useState('');
        const [originalInvocationMode, setOriginalInvocationMode] = useState<'both' | 'userOnly' | 'modelOnly'>('both');
        const [originalAllowedTools, setOriginalAllowedTools] = useState('');
        const [originalContext, setOriginalContext] = useState('');
        const [originalAgent, setOriginalAgent] = useState('');
        const [originalArgumentHint, setOriginalArgumentHint] = useState('');

        // Editable fields
        const [skillName, setSkillName] = useState('');
        const [description, setDescription] = useState('');
        const [body, setBody] = useState('');
        // 调用模式: 'both' = 用户与模型均可, 'userOnly' = 仅用户, 'modelOnly' = 仅模型
        const [invocationMode, setInvocationMode] = useState<'both' | 'userOnly' | 'modelOnly'>('both');
        const [allowedTools, setAllowedTools] = useState('');
        const [context, setContext] = useState('');
        const [agent, setAgent] = useState('');
        const [argumentHint, setArgumentHint] = useState('');

        // 下拉菜单状态
        const [showContextMenu, setShowContextMenu] = useState(false);
        const [showAgentMenu, setShowAgentMenu] = useState(false);
        const contextBtnRef = useRef<HTMLButtonElement>(null);
        const agentBtnRef = useRef<HTMLButtonElement>(null);

        // 输入框 refs 用于焦点控制
        const nameInputRef = useRef<HTMLInputElement>(null);
        const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
        // 跟踪进入编辑模式时应聚焦的字段
        const [focusField, setFocusField] = useState<'name' | 'description' | 'body' | null>(null);

        // Expose isEditing to parent
        useImperativeHandle(ref, () => ({
            isEditing: () => isEditing
        }), [isEditing]);

        // Load skill data
        useEffect(() => {
            let cancelled = false;

            const loadSkill = async () => {
                setLoading(true);
                try {
                    // When using Tab API, no need to pass agentDir (sidecar already has it)
                    // When using global API, include agentDir for project scope
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    const response = await api.get<{ success: boolean; skill: SkillDetail; error?: string }>(
                        `/api/skill/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                    );
                    if (cancelled) return;
                    if (response.success && response.skill) {
                        setSkill(response.skill);
                        const fm = response.skill.frontmatter;
                        const skillNameVal = fm.name || name;
                        const desc = fm.description || '';
                        const bd = response.skill.body || '';
                        setSkillName(skillNameVal);
                        setOriginalSkillName(skillNameVal);
                        setDescription(desc);
                        setBody(bd);
                        setOriginalDescription(desc);
                        setOriginalBody(bd);
                        // 将两个开关值转换为调用模式
                        const disableModel = fm['disable-model-invocation'] || false;
                        const userInvocable = fm['user-invocable'] !== false;
                        let mode: 'both' | 'userOnly' | 'modelOnly' = 'both';
                        if (disableModel && userInvocable) {
                            mode = 'userOnly';
                        } else if (!disableModel && !userInvocable) {
                            mode = 'modelOnly';
                        }
                        setInvocationMode(mode);
                        setOriginalInvocationMode(mode);
                        const tools = fm['allowed-tools'] || '';
                        const ctx = fm.context || '';
                        const ag = fm.agent || '';
                        const argHint = fm['argument-hint'] || '';
                        setAllowedTools(tools);
                        setOriginalAllowedTools(tools);
                        setContext(ctx);
                        setOriginalContext(ctx);
                        setAgent(ag);
                        setOriginalAgent(ag);
                        setArgumentHint(argHint);
                        setOriginalArgumentHint(argHint);
                        // 新建的普通 Skill 自动进入编辑；切换到其它详情时同步退出旧编辑态。
                        setIsEditing(startInEditMode && !response.skill.systemOwned);
                    } else {
                        toastRef.current.error(response.error || tRef.current('resourceDetail.common.loadFailed'));
                    }
                } catch {
                    if (cancelled) return;
                    toastRef.current.error(tRef.current('resourceDetail.common.loadFailed'));
                } finally {
                    if (!cancelled) setLoading(false);
                }
            };
            loadSkill();
            return () => {
                cancelled = true;
            };
        }, [name, scope, agentDir, startInEditMode, api, isInTabContext]);

        // Outside-click + Escape are handled by the `<Popover>` primitive
        // on each dropdown below.

        const canEdit = skill?.systemOwned !== true;

        const handleEdit = useCallback((field?: 'name' | 'description' | 'body') => {
            if (!canEdit) return;
            setFocusField(field || 'name');
            setIsEditing(true);
        }, [canEdit]);

        // 处理进入编辑模式后的焦点（仅处理 name 和 description，body 由 MonacoEditor autoFocus 处理）
        useEffect(() => {
            if (isEditing && focusField && focusField !== 'body') {
                // 使用 setTimeout 确保 DOM 已更新
                const timer = setTimeout(() => {
                    switch (focusField) {
                        case 'name':
                            nameInputRef.current?.focus();
                            break;
                        case 'description':
                            descriptionInputRef.current?.focus();
                            break;
                    }
                    setFocusField(null);
                }, 0);
                return () => clearTimeout(timer);
            }
        }, [isEditing, focusField]);

        const handleCancel = useCallback(async () => {
            if (isNewSkill) {
                // 新创建的技能，取消时删除并返回列表
                try {
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    await api.delete<{ success: boolean }>(`/api/skill/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`);
                } catch {
                    // 忽略删除失败
                }
                onDeleted();
            } else {
                // 普通编辑取消，恢复所有字段到原始值
                setSkillName(originalSkillName);
                setDescription(originalDescription);
                setBody(originalBody);
                setInvocationMode(originalInvocationMode);
                setAllowedTools(originalAllowedTools);
                setContext(originalContext);
                setAgent(originalAgent);
                setArgumentHint(originalArgumentHint);
                setIsEditing(false);
            }
        }, [isNewSkill, name, scope, agentDir, originalSkillName, originalDescription, originalBody, originalInvocationMode, originalAllowedTools, originalContext, originalAgent, originalArgumentHint, onDeleted, api, isInTabContext]);

        // Get the expected new folder name based on current skill name
        const expectedFolderName = skillName.trim() ? sanitizeFolderName(skillName.trim()) : '';

        const handleSave = useCallback(async () => {
            if (!skill) return;
            if (!skillName.trim()) {
                toastRef.current.error(t('resourceDetail.skill.nameRequired'));
                return;
            }
            setSaving(true);
            try {
                const frontmatter: Partial<SkillFrontmatter> = {
                    name: skillName.trim(),
                    description,
                    // These standard fields are not editable in this panel,
                    // so carry them through unchanged. `author` is a normalized
                    // read projection; the shared serializer writes it back as
                    // standard `metadata.author` while preserving legacy reads.
                    license: skill.frontmatter.license,
                    compatibility: skill.frontmatter.compatibility,
                    metadata: skill.frontmatter.metadata,
                    author: skill.frontmatter.author,
                };

                // 将调用模式转换为两个开关值
                if (invocationMode === 'userOnly') {
                    frontmatter['disable-model-invocation'] = true;
                    // user-invocable 默认为 true，不需要设置
                } else if (invocationMode === 'modelOnly') {
                    frontmatter['user-invocable'] = false;
                    // disable-model-invocation 默认为 false，不需要设置
                }
                // 'both' 模式不需要设置任何字段，都使用默认值

                if (allowedTools) frontmatter['allowed-tools'] = allowedTools;
                if (context) frontmatter.context = context;
                if (agent) frontmatter.agent = agent;
                if (argumentHint) frontmatter['argument-hint'] = argumentHint;

                // Check if folder should be renamed (only if user modified name AND sanitized name differs from current folder)
                const newFolderName = sanitizeFolderName(skillName.trim());
                const nameWasModified = skillName.trim() !== originalSkillName;
                const shouldRename = nameWasModified && newFolderName && newFolderName !== skill.folderName;

                // When using Tab API, no need to pass agentDir (sidecar already has it)
                const payload = isInTabContext
                    ? { scope, frontmatter, body, ...(shouldRename ? { newFolderName } : {}) }
                    : { scope, frontmatter, body, ...(shouldRename ? { newFolderName } : {}), ...(scope === 'project' && agentDir ? { agentDir } : {}) };

                const response = await api.put<{
                    success: boolean;
                    error?: string;
                    folderName?: string;
                    fullPath?: string;
                }>(
                    `/api/skill/${encodeURIComponent(name)}`,
                    payload
                );

                if (response.success) {
                    toastRef.current.success(t('resourceDetail.common.saveSuccess'));

                    // If folder was renamed, always close detail view (name prop is now invalid)
                    const folderWasRenamed = response.folderName && response.folderName !== skill.folderName;
                    if (folderWasRenamed) {
                        onSaved(true); // Always auto-close when folder renamed
                        return;
                    }

                    // Update skill state with new path if folder was renamed
                    if (response.folderName && response.fullPath) {
                        setSkill(prev => prev ? {
                            ...prev,
                            folderName: response.folderName!,
                            path: response.fullPath!
                        } : null);
                    }
                    // 更新所有原始值，以便后续取消时恢复
                    setOriginalSkillName(skillName.trim());
                    setOriginalDescription(description);
                    setOriginalBody(body);
                    setOriginalInvocationMode(invocationMode);
                    setOriginalAllowedTools(allowedTools);
                    setOriginalContext(context);
                    setOriginalAgent(agent);
                    setOriginalArgumentHint(argumentHint);
                    setIsEditing(false);
                    const wasNewSkill = isNewSkill;
                    setIsNewSkill(false); // 保存后不再是新技能
                    // 新建技能保存后自动关闭详情返回列表
                    onSaved(wasNewSkill);
                } else {
                    toastRef.current.error(response.error || t('resourceDetail.common.saveFailed'));
                }
            } catch {
                toastRef.current.error(t('resourceDetail.common.saveFailed'));
            } finally {
                setSaving(false);
            }
        }, [skill, name, scope, agentDir, skillName, originalSkillName, description, body, invocationMode, allowedTools, context, agent, argumentHint, onSaved, isNewSkill, api, isInTabContext, t]);

        const handleDelete = useCallback(async () => {
            setDeleting(true);
            try {
                const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                const response = await api.delete<{ success: boolean; error?: string }>(
                    `/api/skill/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                );
                if (response.success) {
                    toastRef.current.success(t('resourceDetail.common.deleteSuccess'));
                    onDeleted();
                } else {
                    toastRef.current.error(response.error || t('resourceDetail.common.deleteFailed'));
                }
            } catch {
                toastRef.current.error(t('resourceDetail.common.deleteFailed'));
            } finally {
                setDeleting(false);
                setShowDeleteConfirm(false);
            }
        }, [name, scope, agentDir, onDeleted, api, isInTabContext, t]);

        // Phase D.5: skill.path is an absolute path (`~/.myagents/skills/<name>/`
        // for global, `<project>/.claude/skills/<name>/` for project), not a
        // workspace-relative path — so we use `cmd_open_path_external` which
        // takes absolute paths and validates them against home/tmp prefix.
        // Issue #125 follow-up: forward `agentDir` for project-scope skills
        // so Rust can accept paths under non-system-drive workspaces (e.g.
        // `D:\project\.claude\skills\foo\`); without this, project skills on
        // Windows non-system drives fail with "Path not allowed".
        const fileService = useWorkspaceFileService(null);
        const handleOpenInFinder = useCallback(async () => {
            if (!skill) return;
            try {
                await fileService.openPathExternal({
                    fullPath: skill.path,
                    workspace: scope === 'project' ? agentDir ?? null : null,
                });
            } catch {
                toastRef.current.error(t('resourceDetail.common.openFolderFailed'));
            }
        }, [skill, fileService, scope, agentDir, t]);

        if (loading) {
            return (
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                </div>
            );
        }

        if (!skill) {
            return (
                <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-[var(--ink-muted)]">{t('resourceDetail.skill.notFound')}</p>
                </div>
            );
        }

        // Calculate preview path based on edited skill name
        // Only show "will rename" if user actually changed the name AND the sanitized folder name is different
        const nameWasModified = skillName.trim() !== originalSkillName;
        const pathChanged = isEditing && nameWasModified && !!expectedFolderName && expectedFolderName !== skill.folderName;
        const previewPath = pathChanged
            ? skill.path.replace(skill.folderName, expectedFolderName)
            : skill.path;

        return (
            <div className="flex h-full flex-col">
                {/* Header */}
                <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-inset)]/50 px-6 py-2">
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <h3 className="truncate text-lg font-semibold text-[var(--ink)]">{skillName || name}</h3>
                            {scope === 'user' && (
                                <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                                    {t('agentSettings.capabilities.scopeUser')}
                                </span>
                            )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                            <span
                                className={`max-w-[300px] truncate font-mono text-xs ${pathChanged ? 'text-[var(--accent)]' : 'text-[var(--ink-muted)]'}`}
                                title={previewPath}
                            >
                                {shortenPathForDisplay(previewPath)}
                            </span>
                            {pathChanged && (
                                <span className="text-xs text-[var(--accent)]">{t('resourceDetail.common.willRename')}</span>
                            )}
                            <button
                                type="button"
                                onClick={handleOpenInFinder}
                                disabled={pathChanged}
                                className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50 disabled:cursor-not-allowed"
                                title={pathChanged ? t('resourceDetail.common.openAfterSave') : t('resourceDetail.common.openLocation')}
                            >
                                <FolderOpen className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {isEditing ? (
                            <div key="editing" className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => setShowDeleteConfirm(true)}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--error)] hover:bg-[var(--error-bg)]"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    {t('resourceDetail.common.delete')}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleCancel}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                                >
                                    <X className="h-4 w-4" />
                                    {t('resourceDetail.common.cancel')}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                                >
                                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                                    {t('resourceDetail.common.save')}
                                </button>
                            </div>
                        ) : canEdit ? (
                            <button
                                key="view"
                                type="button"
                                onClick={() => handleEdit('name')}
                                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-dark-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-dark-text)] transition-colors hover:bg-[var(--button-dark-bg-hover)]"
                            >
                                <Edit2 className="h-4 w-4" />
                                {t('resourceDetail.common.edit')}
                            </button>
                        ) : null}
                    </div>
                </div>

                {/* Content - scrollable area */}
                <div className="flex-1 overflow-auto p-6">
                    <div className="mx-auto max-w-4xl space-y-4">
                        {/* Skill Name */}
                        <div>
                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.common.name')}</label>
                            <div className={`w-full rounded-lg border px-4 py-2.5 ${
                                isEditing
                                    ? 'border-[var(--line)] bg-[var(--paper)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/20'
                                    : 'border-[var(--line)] bg-[var(--paper-elevated)]'
                            }`}>
                                {isEditing ? (
                                    <input
                                        ref={nameInputRef}
                                        type="text"
                                        value={skillName}
                                        onChange={(e) => setSkillName(e.target.value)}
                                        placeholder={t('resourceDetail.skill.namePlaceholder')}
                                        className="w-full border-none bg-transparent p-0 text-sm leading-relaxed text-[var(--ink)] placeholder-[var(--ink-muted)] outline-none"
                                    />
                                ) : (
                                    <span className={`block select-text text-sm leading-relaxed ${skillName ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]/60'}`}>
                                        {skillName || t('resourceDetail.common.notSet')}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Description - 1-4 lines with overflow scroll, same height for edit/preview */}
                        <div>
                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.common.description')}</label>
                            <div
                                className={`w-full rounded-lg border px-4 py-2.5 ${
                                    isEditing
                                        ? 'border-[var(--line)] bg-[var(--paper)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/20'
                                        : 'border-[var(--line)] bg-[var(--paper-elevated)]'
                                }`}
                            >
                                {/* Fixed height container: min 1 line, max 4 lines (22px line-height * 4 = 88px) */}
                                <div className="max-h-[88px] min-h-[22px] overflow-y-auto">
                                    {isEditing ? (
                                        <textarea
                                            ref={(el) => {
                                                // 同时存储 ref 和调整高度
                                                (descriptionInputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
                                                if (el) {
                                                    el.style.height = 'auto';
                                                    el.style.height = Math.max(22, el.scrollHeight) + 'px';
                                                }
                                            }}
                                            value={description}
                                            onChange={(e) => setDescription(e.target.value)}
                                            placeholder={t('resourceDetail.skill.descriptionPlaceholder')}
                                            className="block min-h-[22px] w-full resize-none border-none bg-transparent p-0 text-sm leading-[22px] text-[var(--ink)] placeholder-[var(--ink-muted)] outline-none"
                                            style={{ height: 'auto' }}
                                            onInput={(e) => {
                                                const target = e.target as HTMLTextAreaElement;
                                                target.style.height = 'auto';
                                                target.style.height = Math.max(22, target.scrollHeight) + 'px';
                                            }}
                                        />
                                    ) : (
                                        <div className="select-text whitespace-pre-wrap text-sm leading-[22px]">
                                            <span className={description ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]/60'}>
                                                {description || t('resourceDetail.common.notSet')}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Instructions - same height for edit/preview, adapts to viewport */}
                        <div>
                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.skill.instructions')}</label>
                            <div
                                className={`overflow-hidden rounded-lg border ${
                                    isEditing
                                        ? 'border-[var(--line)] bg-[var(--paper)]'
                                        : 'border-[var(--line)] bg-[var(--paper-elevated)]'
                                }`}
                                style={{ height: 'max(300px, calc(100vh - 420px))' }}
                            >
                                {isEditing ? (
                                    <MonacoEditor
                                        value={body}
                                        onChange={setBody}
                                        language="markdown"
                                        autoFocus={focusField === 'body'}
                                    />
                                ) : (
                                    <div className="h-full overflow-auto p-4">
                                        {body ? (
                                            <div className="ai-message-content">
                                                <Markdown raw>{body}</Markdown>
                                            </div>
                                        ) : (
                                            <span className="text-sm text-[var(--ink-muted)]/60">{t('resourceDetail.skill.emptyContent')}</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Advanced Settings Toggle */}
                        <button
                            type="button"
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="flex items-center gap-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                        >
                            {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            {t('resourceDetail.skill.advancedSettings')}
                        </button>

                        {/* Advanced Settings */}
                        {showAdvanced && (
                            <div className="space-y-4 rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]/30 p-4">
                                {/* Invocation Mode - 调用模式单选 */}
                                <div>
                                    <label className="mb-2 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.skill.invocationMode')}</label>
                                    <div className="flex flex-wrap gap-2">
                                        {[
                                            { value: 'both', label: t('resourceDetail.skill.invocationBoth'), desc: t('resourceDetail.skill.invocationBothDesc') },
                                            { value: 'userOnly', label: t('resourceDetail.skill.invocationUserOnly'), desc: t('resourceDetail.skill.invocationUserOnlyDesc') },
                                            { value: 'modelOnly', label: t('resourceDetail.skill.invocationModelOnly'), desc: t('resourceDetail.skill.invocationModelOnlyDesc') },
                                        ].map((option) => (
                                            <button
                                                key={option.value}
                                                type="button"
                                                onClick={() => { if (isEditing) setInvocationMode(option.value as 'both' | 'userOnly' | 'modelOnly'); else handleEdit(); }}
                                                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                                                    invocationMode === option.value
                                                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                                                        : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] hover:border-[var(--ink-muted)]/50'
                                                } ${!isEditing ? 'opacity-70' : ''}`}
                                            >
                                                <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                                                    invocationMode === option.value
                                                        ? 'border-[var(--accent)] bg-[var(--accent)]'
                                                        : 'border-[var(--ink-muted)]/50'
                                                }`}>
                                                    {invocationMode === option.value && <Check className="h-2.5 w-2.5 text-[var(--on-accent)]" />}
                                                </span>
                                                <span>{option.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                    <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                                        {invocationMode === 'both' && t('resourceDetail.skill.invocationBothHelp')}
                                        {invocationMode === 'userOnly' && t('resourceDetail.skill.invocationUserOnlyHelp')}
                                        {invocationMode === 'modelOnly' && t('resourceDetail.skill.invocationModelOnlyHelp')}
                                    </p>
                                </div>

                                {/* Allowed Tools - 白名单 */}
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.skill.allowedTools')}</label>
                                    <p className="mb-2 text-xs text-[var(--ink-muted)]">{t('resourceDetail.skill.allowedToolsHelp')}</p>
                                    {isEditing ? (
                                        <input
                                            type="text"
                                            value={allowedTools}
                                            onChange={(e) => setAllowedTools(e.target.value)}
                                            placeholder={t('resourceDetail.skill.allowedToolsPlaceholder')}
                                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none"
                                        />
                                    ) : (
                                        <div onClick={() => handleEdit()} className="w-full cursor-pointer rounded-lg border border-[var(--line)] bg-[var(--paper-inset)]/30 px-3 py-2 text-sm transition-colors hover:border-[var(--ink-muted)]/50">
                                            {allowedTools || <span className="text-[var(--ink-muted)]/60">{t('resourceDetail.skill.unrestricted')}</span>}
                                        </div>
                                    )}
                                </div>

                                {/* Context - 自定义下拉 */}
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.skill.context')}</label>
                                    <button
                                        ref={contextBtnRef}
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (isEditing) {
                                                setShowContextMenu(!showContextMenu);
                                                setShowAgentMenu(false);
                                            } else {
                                                handleEdit();
                                            }
                                        }}
                                        className={`flex w-full items-center justify-between rounded-lg border border-[var(--line)] px-3 py-2 text-left text-sm transition-colors ${
                                            isEditing ? 'bg-[var(--paper)] hover:border-[var(--ink-muted)]/50' : 'bg-[var(--paper-inset)]/30 opacity-70'
                                        }`}
                                    >
                                        <span className={context ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}>
                                            {context === 'fork' ? t('resourceDetail.skill.contextFork') : t('resourceDetail.skill.contextDefault')}
                                        </span>
                                        <ChevronDown className="h-4 w-4 text-[var(--ink-muted)]" />
                                    </button>
                                    <Popover
                                        open={showContextMenu && isEditing}
                                        onClose={() => setShowContextMenu(false)}
                                        anchorRef={contextBtnRef}
                                        placement="bottom-start"
                                        matchAnchorWidth
                                        className="py-1 shadow-lg"
                                    >
                                        {[
                                            { value: '', label: t('resourceDetail.skill.contextDefault'), desc: t('resourceDetail.skill.contextDefaultDesc') },
                                            { value: 'fork', label: t('resourceDetail.skill.contextFork'), desc: t('resourceDetail.skill.contextForkDesc') },
                                        ].map((option) => (
                                            <button
                                                key={option.value}
                                                type="button"
                                                onClick={() => {
                                                    setContext(option.value);
                                                    setShowContextMenu(false);
                                                }}
                                                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--paper-inset)] ${
                                                    context === option.value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'
                                                }`}
                                            >
                                                <div>
                                                    <div className="font-medium">{option.label}</div>
                                                    <div className="text-xs text-[var(--ink-muted)]">{option.desc}</div>
                                                </div>
                                                {context === option.value && <Check className="h-4 w-4" />}
                                            </button>
                                        ))}
                                    </Popover>
                                </div>

                                {/* Agent - 自定义下拉 */}
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.skill.agentType')}</label>
                                    <button
                                        ref={agentBtnRef}
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (isEditing) {
                                                setShowAgentMenu(!showAgentMenu);
                                                setShowContextMenu(false);
                                            } else {
                                                handleEdit();
                                            }
                                        }}
                                        className={`flex w-full items-center justify-between rounded-lg border border-[var(--line)] px-3 py-2 text-left text-sm transition-colors ${
                                            isEditing ? 'bg-[var(--paper)] hover:border-[var(--ink-muted)]/50' : 'bg-[var(--paper-inset)]/30 opacity-70'
                                        }`}
                                    >
                                        <span className={agent ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}>
                                            {agent === 'Explore' && t('resourceDetail.skill.agentExplore')}
                                            {agent === 'Plan' && t('resourceDetail.skill.agentPlan')}
                                            {agent === 'general-purpose' && t('resourceDetail.skill.agentGeneral')}
                                            {!agent && t('resourceDetail.skill.agentDefault')}
                                        </span>
                                        <ChevronDown className="h-4 w-4 text-[var(--ink-muted)]" />
                                    </button>
                                    <Popover
                                        open={showAgentMenu && isEditing}
                                        onClose={() => setShowAgentMenu(false)}
                                        anchorRef={agentBtnRef}
                                        placement="bottom-start"
                                        matchAnchorWidth
                                        className="py-1 shadow-lg"
                                    >
                                        {[
                                            { value: '', label: t('resourceDetail.skill.agentDefault'), desc: t('resourceDetail.skill.agentDefaultDesc') },
                                            { value: 'Explore', label: t('resourceDetail.skill.agentExplore'), desc: t('resourceDetail.skill.agentExploreDesc') },
                                            { value: 'Plan', label: t('resourceDetail.skill.agentPlan'), desc: t('resourceDetail.skill.agentPlanDesc') },
                                            { value: 'general-purpose', label: t('resourceDetail.skill.agentGeneral'), desc: t('resourceDetail.skill.agentGeneralDesc') },
                                        ].map((option) => (
                                            <button
                                                key={option.value}
                                                type="button"
                                                onClick={() => {
                                                    setAgent(option.value);
                                                    setShowAgentMenu(false);
                                                }}
                                                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--paper-inset)] ${
                                                    agent === option.value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'
                                                }`}
                                            >
                                                <div>
                                                    <div className="font-medium">{option.label}</div>
                                                    <div className="text-xs text-[var(--ink-muted)]">{option.desc}</div>
                                                </div>
                                                {agent === option.value && <Check className="h-4 w-4" />}
                                            </button>
                                        ))}
                                    </Popover>
                                </div>

                                {/* Argument Hint */}
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.skill.argumentHint')}</label>
                                    {isEditing ? (
                                        <input
                                            type="text"
                                            value={argumentHint}
                                            onChange={(e) => setArgumentHint(e.target.value)}
                                            placeholder={t('resourceDetail.skill.argumentHintPlaceholder')}
                                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none"
                                        />
                                    ) : (
                                        <div onClick={() => handleEdit()} className="w-full cursor-pointer rounded-lg border border-[var(--line)] bg-[var(--paper-inset)]/30 px-3 py-2 text-sm transition-colors hover:border-[var(--ink-muted)]/50">
                                            {argumentHint || <span className="text-[var(--ink-muted)]/60">{t('resourceDetail.common.notSet')}</span>}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Delete Confirmation */}
                {showDeleteConfirm && (
                    <ConfirmDialog
                        title={t('resourceDetail.skill.deleteTitle')}
                        message={t('resourceDetail.skill.deleteMessage', { name: skill.frontmatter.name || name })}
                        confirmText={t('resourceDetail.common.delete')}
                        confirmVariant="danger"
                        onConfirm={handleDelete}
                        onCancel={() => setShowDeleteConfirm(false)}
                        loading={deleting}
                    />
                )}
            </div>
        );
    });

export default SkillDetailPanel;
