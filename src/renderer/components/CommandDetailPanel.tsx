/**
 * CommandDetailPanel - Component for viewing and editing a Command
 * Supports preview/edit mode with save confirmation and file rename
 * UI structure matches SkillDetailPanel for consistency
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalSkillsPanel).
 */
import { Save, FolderOpen, Loader2, Trash2, Edit2, X } from 'lucide-react';
import { useCallback, useEffect, useState, useImperativeHandle, forwardRef, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGetJson as globalApiGet, apiPutJson as globalApiPut, apiDelete as globalApiDelete, apiPostJson as globalApiPost } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import type { CommandFrontmatter, CommandDetail } from '../../shared/skillsTypes';
import { sanitizeFolderName } from '../../shared/utils';
import { shortenPathForDisplay } from '@/utils/pathDetection';

interface CommandDetailPanelProps {
    name: string;
    scope: 'user' | 'project';
    onBack: () => void;
    /** 保存成功回调，autoClose 为 true 时父组件应关闭详情视图 */
    onSaved: (autoClose?: boolean) => void;
    onDeleted: () => void;
    /** 项目目录，用于 scope='project' 时的文件操作 */
    agentDir?: string;
}

export interface CommandDetailPanelRef {
    isEditing: () => boolean;
}

const CommandDetailPanel = forwardRef<CommandDetailPanelRef, CommandDetailPanelProps>(
    function CommandDetailPanel({ name, scope, onBack: _onBack, onSaved, onDeleted, agentDir }, ref) {
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
        const [command, setCommand] = useState<CommandDetail | null>(null);
        const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
        const [deleting, setDeleting] = useState(false);
        const [isEditing, setIsEditing] = useState(false);

        // Original values for comparison
        const [originalCommandName, setOriginalCommandName] = useState('');
        const [originalDescription, setOriginalDescription] = useState('');
        const [originalBody, setOriginalBody] = useState('');

        // Editable fields
        const [commandName, setCommandName] = useState('');
        const [description, setDescription] = useState('');
        const [body, setBody] = useState('');

        // Input refs for focus control
        const nameInputRef = useRef<HTMLInputElement>(null);
        const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
        // Track which field should receive focus when entering edit mode
        const [focusField, setFocusField] = useState<'name' | 'description' | 'body' | null>(null);

        // Expose isEditing to parent
        useImperativeHandle(ref, () => ({
            isEditing: () => isEditing
        }), [isEditing]);

        // Load command data
        useEffect(() => {
            const loadCommand = async () => {
                setLoading(true);
                try {
                    // When using Tab API, no need to pass agentDir (sidecar already has it)
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    const response = await api.get<{ success: boolean; command: CommandDetail; error?: string }>(
                        `/api/command-item/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                    );
                    if (response.success && response.command) {
                        setCommand(response.command);
                        const cmdName = response.command.name || name;
                        const desc = response.command.frontmatter.description || '';
                        const bd = response.command.body || '';
                        setCommandName(cmdName);
                        setOriginalCommandName(cmdName);
                        setDescription(desc);
                        setBody(bd);
                        setOriginalDescription(desc);
                        setOriginalBody(bd);
                    } else {
                        toastRef.current.error(response.error || tRef.current('resourceDetail.common.loadFailed'));
                    }
                } catch {
                    toastRef.current.error(tRef.current('resourceDetail.common.loadFailed'));
                } finally {
                    setLoading(false);
                }
            };
            loadCommand();
        }, [name, scope, agentDir, api, isInTabContext]);

        const handleEdit = useCallback((field?: 'name' | 'description' | 'body') => {
            setFocusField(field || 'name');
            setIsEditing(true);
        }, []);

        // Handle focus when entering edit mode (body is handled by MonacoEditor autoFocus)
        useEffect(() => {
            if (isEditing && focusField && focusField !== 'body') {
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

        const handleCancel = useCallback(() => {
            setCommandName(originalCommandName);
            setDescription(originalDescription);
            setBody(originalBody);
            setIsEditing(false);
        }, [originalCommandName, originalDescription, originalBody]);

        // Get the expected new file name based on current command name
        const expectedFileName = commandName.trim() ? sanitizeFolderName(commandName.trim()) : '';

        const handleSave = useCallback(async () => {
            if (!command) return;
            if (!commandName.trim()) {
                toastRef.current.error(t('resourceDetail.command.nameRequired'));
                return;
            }
            setSaving(true);
            try {
                const frontmatter: Partial<CommandFrontmatter> = {
                    name: commandName.trim(),
                    description,
                };

                // Check if file should be renamed (only if user modified name AND sanitized name differs from current file)
                const newFileName = sanitizeFolderName(commandName.trim());
                const currentFileName = command.fileName || name;
                const nameWasModified = commandName.trim() !== originalCommandName;
                const shouldRename = nameWasModified && newFileName && newFileName !== currentFileName;

                // When using Tab API, no need to pass agentDir (sidecar already has it)
                const payload = isInTabContext
                    ? { scope, frontmatter, body, ...(shouldRename ? { newFileName } : {}) }
                    : { scope, frontmatter, body, ...(shouldRename ? { newFileName } : {}), ...(scope === 'project' && agentDir ? { agentDir } : {}) };

                const response = await api.put<{
                    success: boolean;
                    error?: string;
                    fileName?: string;
                    path?: string;
                }>(
                    `/api/command-item/${encodeURIComponent(currentFileName)}`,
                    payload
                );

                if (response.success) {
                    toastRef.current.success(t('resourceDetail.common.saveSuccess'));

                    // If file was renamed, always close detail view (name prop is now invalid)
                    const fileWasRenamed = response.fileName && response.fileName !== currentFileName;
                    if (fileWasRenamed) {
                        onSaved(true); // Auto-close when file renamed
                        return;
                    }

                    // Update command state with new path if file was renamed
                    if (response.fileName && response.path) {
                        setCommand(prev => prev ? {
                            ...prev,
                            name: commandName.trim(),
                            fileName: response.fileName!,
                            path: response.path!
                        } : null);
                    }

                    // Update original values
                    setOriginalCommandName(commandName.trim());
                    setOriginalDescription(description);
                    setOriginalBody(body);
                    setIsEditing(false);
                    onSaved();
                } else {
                    toastRef.current.error(response.error || t('resourceDetail.common.saveFailed'));
                }
            } catch {
                toastRef.current.error(t('resourceDetail.common.saveFailed'));
            } finally {
                setSaving(false);
            }
        }, [command, name, scope, agentDir, commandName, originalCommandName, description, body, onSaved, api, isInTabContext, t]);

        const handleDelete = useCallback(async () => {
            if (!command) return;
            setDeleting(true);
            try {
                const currentFileName = command.fileName || name;
                const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                const response = await api.delete<{ success: boolean; error?: string }>(
                    `/api/command-item/${encodeURIComponent(currentFileName)}?scope=${scope}${agentDirParam}`
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
        }, [command, name, scope, agentDir, onDeleted, api, isInTabContext, t]);

        // Phase D.5: command.path is an absolute path; route through the
        // dedicated `cmd_open_path_external` invoke (validates home/tmp prefix)
        // instead of sidecar `/agent/open-path`.
        // Issue #125 follow-up: forward `agentDir` for project-scope commands
        // so Rust accepts paths under non-system-drive workspaces (e.g.
        // `D:\project\.claude\commands\foo.md`).
        const fileService = useWorkspaceFileService(null);
        const handleOpenInFinder = useCallback(async () => {
            if (!command) return;
            try {
                await fileService.openPathExternal({
                    fullPath: command.path,
                    workspace: scope === 'project' ? agentDir ?? null : null,
                });
            } catch {
                toastRef.current.error(t('resourceDetail.common.openFolderFailed'));
            }
        }, [command, fileService, scope, agentDir, t]);

        if (loading) {
            return (
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                </div>
            );
        }

        if (!command) {
            return (
                <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-[var(--ink-muted)]">{t('resourceDetail.command.notFound')}</p>
                </div>
            );
        }

        // Calculate preview path based on edited command name
        // Only show "will rename" if user actually changed the name AND the sanitized file name is different
        const currentFileName = command.fileName || name;
        const nameWasModified = commandName.trim() !== originalCommandName;
        const pathChanged = isEditing && nameWasModified && !!expectedFileName && expectedFileName !== currentFileName;
        const previewPath = pathChanged
            ? command.path.replace(`${currentFileName}.md`, `${expectedFileName}.md`)
            : command.path;

        return (
            <div className="flex h-full flex-col">
                {/* Header */}
                <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-inset)]/50 px-6 py-2">
                    <div className="min-w-0 flex-1">
                        <h3 className="truncate text-lg font-semibold text-[var(--ink)]">{commandName || name}</h3>
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
                        ) : (
                            <button
                                key="view"
                                type="button"
                                onClick={() => handleEdit('name')}
                                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-dark-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-dark-text)] transition-colors hover:bg-[var(--button-dark-bg-hover)]"
                            >
                                <Edit2 className="h-4 w-4" />
                                {t('resourceDetail.common.edit')}
                            </button>
                        )}
                    </div>
                </div>

                {/* Content - scrollable area */}
                <div className="flex-1 overflow-auto p-6">
                    <div className="mx-auto max-w-4xl space-y-4">
                        {/* Command Name */}
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
                                        value={commandName}
                                        onChange={(e) => setCommandName(e.target.value)}
                                        placeholder={t('resourceDetail.command.namePlaceholder')}
                                        className="w-full border-none bg-transparent p-0 text-sm leading-relaxed text-[var(--ink)] placeholder-[var(--ink-muted)] outline-none"
                                    />
                                ) : (
                                    <span className={`block select-text text-sm leading-relaxed ${commandName ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]/60'}`}>
                                        {commandName || t('resourceDetail.common.notSet')}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Description - 1-4 lines with overflow scroll */}
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
                                                (descriptionInputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
                                                if (el) {
                                                    el.style.height = 'auto';
                                                    el.style.height = Math.max(22, el.scrollHeight) + 'px';
                                                }
                                            }}
                                            value={description}
                                            onChange={(e) => setDescription(e.target.value)}
                                            placeholder={t('resourceDetail.command.descriptionPlaceholder')}
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
                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">{t('resourceDetail.command.instructions')}</label>
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
                                            <span className="text-sm text-[var(--ink-muted)]/60">{t('resourceDetail.command.emptyContent')}</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Delete Confirmation */}
                {showDeleteConfirm && (
                    <ConfirmDialog
                        title={t('resourceDetail.command.deleteTitle')}
                        message={t('resourceDetail.command.deleteMessage', { name: commandName })}
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

export default CommandDetailPanel;
