/**
 * SystemPromptsPanel - Manages CLAUDE.md + .claude/rules/*.md files
 * Replaces ClaudeMdEditor with multi-file support for system prompt rules.
 *
 * Uses Tab-scoped API when in Tab context, falls back to global API otherwise.
 */
import { Save, Edit2, X, Plus, FileText, AlertCircle, Loader2, Trash2, Sparkles, FolderArchive } from 'lucide-react';
import { useCallback, useEffect, useState, useImperativeHandle, forwardRef, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { apiGetJson as globalApiGet, apiPostJson as globalApiPost, apiPutJson as globalApiPut, apiDelete as globalApiDelete } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useToast } from '@/components/Toast';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import ConfirmDialog from '@/components/ConfirmDialog';
import TemplateApplyDialog from '@/components/TemplateApplyDialog';

interface SystemPromptsPanelProps {
    agentDir: string;
    /** Optional callback for the empty-state "智能生成 (/init)" card. Sends `/init` to the
     *  current Tab's chat session. Caller is expected to also close the settings overlay
     *  so the user can see the AI generation. If omitted, the card is hidden. */
    onRequestInit?: () => void;
}

export interface SystemPromptsPanelRef {
    isEditing: () => boolean;
}

/** Which file is selected */
type FileId = { type: 'claude-md' } | { type: 'rule'; filename: string };

interface RuleContentResponse {
    success: boolean;
    exists: boolean;
    content: string;
    error?: string;
}

const SystemPromptsPanel = forwardRef<SystemPromptsPanelRef, SystemPromptsPanelProps>(
    function SystemPromptsPanel({ agentDir, onRequestInit }, ref) {
        const { t } = useTranslation('settings');
        const toast = useToast();
        // Stabilize toast reference to avoid unnecessary effect re-runs (project convention)
        const toastRef = useRef(toast);
        useEffect(() => { toastRef.current = toast; }, [toast]);
        const tRef = useRef(t);
        tRef.current = t;

        // Tab-scoped API
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

        // Phase E (PRD 0.2.7): CLAUDE.md goes through Rust workspace_files
        // (`cmd_workspace_read_claude_md` / `cmd_workspace_write_claude_md`).
        // The legacy `/api/claude-md` endpoints are removed in this phase.
        // `.claude/rules/*` keeps using sidecar HTTP for now — those have
        // separate `/api/rules` handlers not in the migration scope.
        const fileService = useWorkspaceFileService(agentDir || null);
        const fileServiceRef = useRef(fileService);
        useEffect(() => { fileServiceRef.current = fileService; }, [fileService]);

        // Async safety: isMountedRef guard (project convention)
        const isMountedRef = useRef(false);
        useEffect(() => {
            isMountedRef.current = true;
            return () => { isMountedRef.current = false; };
        }, []);

        // State
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [activeFile, setActiveFile] = useState<FileId>({ type: 'claude-md' });
        const [ruleFiles, setRuleFiles] = useState<string[]>([]);
        const [content, setContent] = useState('');
        const [editContent, setEditContent] = useState('');
        const [isEditing, setIsEditing] = useState(false);
        const [exists, setExists] = useState(false);
        const [error, setError] = useState<string | null>(null);

        // Inline new-file input
        const [isCreating, setIsCreating] = useState(false);
        const [newFileName, setNewFileName] = useState('');
        const newFileInputRef = useRef<HTMLInputElement>(null);

        // Inline rename
        const [renamingFile, setRenamingFile] = useState<string | null>(null);
        const [renameValue, setRenameValue] = useState('');
        const renameInputRef = useRef<HTMLInputElement>(null);

        // Delete confirmation
        const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

        // Empty-state "从模板库添加" dialog
        const [templateDialogOpen, setTemplateDialogOpen] = useState(false);

        // Double-submit guard for inline inputs (Enter + blur race)
        const submittingRef = useRef(false);

        // Custom tooltip for [+] button (fixed positioning to avoid overflow clip)
        const [addTipPos, setAddTipPos] = useState<{ x: number; y: number } | null>(null);
        const addTipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
        const addBtnRef = useRef<HTMLButtonElement>(null);

        // Expose isEditing to parent
        useImperativeHandle(ref, () => ({
            isEditing: () => isEditing
        }), [isEditing]);

        // Helper to build endpoint with optional agentDir
        const buildEndpoint = useCallback((path: string, extraParams?: string) => {
            if (isInTabContext) return path + (extraParams ? `?${extraParams}` : '');
            const sep = path.includes('?') ? '&' : '?';
            return `${path}${sep}agentDir=${encodeURIComponent(agentDir)}${extraParams ? `&${extraParams}` : ''}`;
        }, [isInTabContext, agentDir]);

        // Load rule file list
        const loadRuleFiles = useCallback(async () => {
            try {
                const res = await api.get<{ success: boolean; files: string[] }>(buildEndpoint('/api/rules'));
                if (isMountedRef.current && res.success) {
                    setRuleFiles(res.files);
                }
            } catch {
                // silent - rules dir may not exist yet
            }
        }, [api, buildEndpoint]);

        // Load file content for the active file
        // Uses a request counter to discard stale responses from overlapping calls
        const loadRequestIdRef = useRef(0);
        const loadFileContent = useCallback(async (file: FileId) => {
            const requestId = ++loadRequestIdRef.current;
            setLoading(true);
            setError(null);
            try {
                if (file.type === 'claude-md') {
                    // Phase E (PRD 0.2.7): CLAUDE.md read goes through Rust
                    // workspace_files (`cmd_workspace_read_claude_md`) instead
                    // of sidecar `/api/claude-md`. The Rust cmd resolves with
                    // `{ exists, path, content }` (or rejects on real error);
                    // missing file → `exists: false, content: ''`.
                    const res = await fileServiceRef.current.readClaudeMd();
                    if (!isMountedRef.current || requestId !== loadRequestIdRef.current) return;
                    setContent(res.content);
                    setEditContent(res.content);
                    setExists(res.exists);
                } else {
                    const endpoint = buildEndpoint(`/api/rules/${encodeURIComponent(file.filename)}`);
                    const res = await api.get<RuleContentResponse>(endpoint);
                    if (!isMountedRef.current || requestId !== loadRequestIdRef.current) return;
                    if (res.success) {
                        setContent(res.content);
                        setEditContent(res.content);
                        setExists(res.exists);
                    } else {
                        setError(res.error || 'Failed to load file');
                    }
                }
            } catch (err) {
                if (!isMountedRef.current || requestId !== loadRequestIdRef.current) return;
                setError(err instanceof Error ? err.message : 'Failed to load file');
            } finally {
                if (isMountedRef.current && requestId === loadRequestIdRef.current) {
                    setLoading(false);
                }
            }
        }, [api, buildEndpoint]);

        // Initial load
        useEffect(() => {
            loadRuleFiles();
            loadFileContent({ type: 'claude-md' });
        }, [loadRuleFiles, loadFileContent]);

        // Switch file
        const handleSwitchFile = useCallback((file: FileId) => {
            if (isEditing) {
                toastRef.current.warning(tRef.current('agentSettings.panel.unsavedWarning'));
                return;
            }
            setActiveFile(file);
            loadFileContent(file);
        }, [isEditing, loadFileContent]);

        // Edit mode
        const handleEdit = useCallback(() => {
            setEditContent(content);
            setIsEditing(true);
        }, [content]);

        const handleCancel = useCallback(() => {
            setEditContent(content);
            setIsEditing(false);
        }, [content]);

        // Save
        const handleSave = useCallback(async () => {
            setSaving(true);
            try {
                if (activeFile.type === 'claude-md') {
                    // Phase E (PRD 0.2.7): write via Rust workspace_files —
                    // `cmd_workspace_write_claude_md` does atomic tmp+rename
                    // + symlink-escape gate.
                    try {
                        await fileServiceRef.current.writeClaudeMd({ content: editContent });
                        if (!isMountedRef.current) return;
                        setContent(editContent);
                        setExists(true);
                        setIsEditing(false);
                        toastRef.current.success(tRef.current('agentSettings.systemPrompts.claudeSaveSuccess'));
                    } catch (err) {
                        if (!isMountedRef.current) return;
                        toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.saveFailed'));
                    }
                } else {
                    const endpoint = buildEndpoint(`/api/rules/${encodeURIComponent(activeFile.filename)}`);
                    const res = await api.put<{ success: boolean; error?: string }>(endpoint, { content: editContent });
                    if (!isMountedRef.current) return;
                    if (res.success) {
                        setContent(editContent);
                        setExists(true);
                        setIsEditing(false);
                        toastRef.current.success(tRef.current('agentSettings.systemPrompts.ruleSaveSuccess', { filename: activeFile.filename }));
                    } else {
                        toastRef.current.error(res.error || tRef.current('agentSettings.common.saveFailed'));
                    }
                }
            } catch (err) {
                if (!isMountedRef.current) return;
                toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.saveFailed'));
            } finally {
                if (isMountedRef.current) setSaving(false);
            }
        }, [activeFile, editContent, api, buildEndpoint]);

        // Create new rule file (with double-submit guard)
        const handleCreateSubmit = useCallback(async () => {
            if (submittingRef.current) return;
            const name = newFileName.trim();
            if (!name) {
                setIsCreating(false);
                setNewFileName('');
                return;
            }
            submittingRef.current = true;
            const filename = name.endsWith('.md') ? name : `${name}.md`;
            try {
                const endpoint = buildEndpoint('/api/rules');
                const res = await api.post<{ success: boolean; filename?: string; error?: string }>(endpoint, { name: filename });
                if (!isMountedRef.current) return;
                if (res.success) {
                    setIsCreating(false);
                    setNewFileName('');
                    await loadRuleFiles();
                    // Switch to new file
                    const actualFilename = res.filename || filename;
                    setActiveFile({ type: 'rule', filename: actualFilename });
                    loadFileContent({ type: 'rule', filename: actualFilename });
                } else {
                    toastRef.current.error(res.error || tRef.current('agentSettings.common.createFailed'));
                }
            } catch {
                if (isMountedRef.current) toastRef.current.error(tRef.current('agentSettings.common.createFailed'));
            } finally {
                submittingRef.current = false;
            }
        }, [newFileName, api, buildEndpoint, loadRuleFiles, loadFileContent]);

        // Rename rule file (with double-submit guard)
        const handleRenameSubmit = useCallback(async () => {
            if (submittingRef.current) return;
            if (!renamingFile) return;
            const newName = renameValue.trim();
            if (!newName) {
                setRenamingFile(null);
                return;
            }
            const newFilename = newName.endsWith('.md') ? newName : `${newName}.md`;
            if (newFilename === renamingFile) {
                setRenamingFile(null);
                return;
            }
            submittingRef.current = true;
            try {
                const endpoint = buildEndpoint(`/api/rules/${encodeURIComponent(renamingFile)}/rename`);
                const res = await api.put<{ success: boolean; filename?: string; error?: string }>(endpoint, { newName: newFilename });
                if (!isMountedRef.current) return;
                if (res.success) {
                    const actualFilename = res.filename || newFilename;
                    setRenamingFile(null);
                    await loadRuleFiles();
                    // If renaming the active file, update active
                    if (activeFile.type === 'rule' && activeFile.filename === renamingFile) {
                        setActiveFile({ type: 'rule', filename: actualFilename });
                    }
                } else {
                    toastRef.current.error(res.error || tRef.current('agentSettings.common.renameFailed'));
                }
            } catch {
                if (isMountedRef.current) toastRef.current.error(tRef.current('agentSettings.common.renameFailed'));
            } finally {
                submittingRef.current = false;
            }
        }, [renamingFile, renameValue, api, buildEndpoint, loadRuleFiles, activeFile]);

        // Delete rule file
        const handleDeleteConfirm = useCallback(async () => {
            if (!deleteTarget) return;
            try {
                const endpoint = buildEndpoint(`/api/rules/${encodeURIComponent(deleteTarget)}`);
                const res = await api.delete<{ success: boolean; error?: string }>(endpoint);
                if (!isMountedRef.current) return;
                if (res.success) {
                    toastRef.current.success(tRef.current('agentSettings.systemPrompts.fileDeleted'));
                    setDeleteTarget(null);
                    setIsEditing(false);
                    await loadRuleFiles();
                    // If deleted the active file, switch to CLAUDE.md
                    if (activeFile.type === 'rule' && activeFile.filename === deleteTarget) {
                        setActiveFile({ type: 'claude-md' });
                        loadFileContent({ type: 'claude-md' });
                    }
                } else {
                    toastRef.current.error(res.error || tRef.current('agentSettings.common.deleteFailed'));
                }
            } catch {
                if (isMountedRef.current) toastRef.current.error(tRef.current('agentSettings.common.deleteFailed'));
            }
        }, [deleteTarget, api, buildEndpoint, loadRuleFiles, activeFile, loadFileContent]);

        // Focus inputs when shown
        useEffect(() => {
            if (isCreating) newFileInputRef.current?.focus();
        }, [isCreating]);
        useEffect(() => {
            if (renamingFile) renameInputRef.current?.focus();
        }, [renamingFile]);

        const activeFilename = activeFile.type === 'claude-md' ? 'CLAUDE.md' : activeFile.filename;
        const isClaudeMd = activeFile.type === 'claude-md';

        if (error && !loading) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
                    <AlertCircle className="h-12 w-12 text-[var(--error)]" />
                    <p className="text-sm text-[var(--ink-muted)]">{error}</p>
                </div>
            );
        }

        return (
            <div className="flex h-full flex-col">
                {/* File Tab Bar */}
                <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--line)] bg-[var(--paper-inset)]/50 px-4 py-1.5">
                    {/* CLAUDE.md tab - always first, not deletable */}
                    <button
                        type="button"
                        onClick={() => handleSwitchFile({ type: 'claude-md' })}
                        className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                            isClaudeMd
                                ? 'bg-[var(--paper)] text-[var(--accent-warm)] shadow-sm'
                                : 'text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]'
                        }`}
                    >
                        <FileText className="h-3.5 w-3.5" />
                        CLAUDE.md
                    </button>

                    {/* Separator */}
                    {ruleFiles.length > 0 && (
                        <div className="mx-1 h-4 w-px shrink-0 bg-[var(--line)]" />
                    )}

                    {/* Rule file tabs */}
                    {ruleFiles.map(filename => {
                        const isActive = activeFile.type === 'rule' && activeFile.filename === filename;
                        const isRenaming = renamingFile === filename;

                        if (isRenaming) {
                            return (
                                <div key={filename} className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--paper)] px-2 py-1 shadow-sm">
                                    <input
                                        ref={renameInputRef}
                                        type="text"
                                        value={renameValue}
                                        onChange={e => setRenameValue(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') handleRenameSubmit();
                                            if (e.key === 'Escape') setRenamingFile(null);
                                        }}
                                        onBlur={handleRenameSubmit}
                                        className="w-24 bg-transparent text-xs text-[var(--ink)] outline-none"
                                    />
                                    <span className="text-xs text-[var(--ink-muted)]">.md</span>
                                </div>
                            );
                        }

                        return (
                            <div
                                key={filename}
                                className={`group flex shrink-0 items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                    isActive
                                        ? 'bg-[var(--paper)] text-[var(--accent-warm)] shadow-sm'
                                        : 'cursor-pointer text-[var(--ink-muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]'
                                }`}
                                onClick={() => handleSwitchFile({ type: 'rule', filename })}
                                onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    if (isEditing) {
                                        toastRef.current.warning(tRef.current('agentSettings.panel.unsavedWarning'));
                                        return;
                                    }
                                    setRenamingFile(filename);
                                    setRenameValue(filename.replace(/\.md$/, ''));
                                }}
                            >
                                <span className="max-w-[120px] truncate">{filename}</span>
                            </div>
                        );
                    })}

                    {/* New file inline input — disabled during editing */}
                    {isCreating ? (
                        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--paper)] px-2 py-1 shadow-sm">
                            <input
                                ref={newFileInputRef}
                                type="text"
                                value={newFileName}
                                onChange={e => setNewFileName(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleCreateSubmit();
                                    if (e.key === 'Escape') {
                                        setIsCreating(false);
                                        setNewFileName('');
                                    }
                                }}
                                onBlur={() => {
                                    if (newFileName.trim()) {
                                        handleCreateSubmit();
                                    } else {
                                        setIsCreating(false);
                                        setNewFileName('');
                                    }
                                }}
                                placeholder={t('agentSettings.systemPrompts.newRulePlaceholder')}
                                className="w-20 bg-transparent text-xs text-[var(--ink)] placeholder:text-[var(--ink-muted)]/50 outline-none"
                            />
                            <span className="text-xs text-[var(--ink-muted)]">.md</span>
                        </div>
                    ) : (
                        <div className="relative shrink-0">
                            <button
                                ref={addBtnRef}
                                type="button"
                                onClick={() => {
                                    if (isEditing) {
                                        toastRef.current.warning(tRef.current('agentSettings.panel.unsavedWarning'));
                                        return;
                                    }
                                    setIsCreating(true);
                                    setAddTipPos(null);
                                }}
                                onMouseEnter={() => {
                                    addTipTimer.current = setTimeout(() => {
                                        const rect = addBtnRef.current?.getBoundingClientRect();
                                        if (rect) {
                                            setAddTipPos({ x: rect.left + rect.width / 2, y: rect.bottom + 6 });
                                        }
                                    }, 400);
                                }}
                                onMouseLeave={() => {
                                    if (addTipTimer.current) clearTimeout(addTipTimer.current);
                                    setAddTipPos(null);
                                }}
                                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </button>
                            {addTipPos && (
                                <div
                                    className="fixed z-50 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 shadow-lg"
                                    style={{ left: addTipPos.x, top: addTipPos.y }}
                                >
                                    <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
                                        {t('agentSettings.systemPrompts.ruleTooltip')}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Action Bar */}
                {!loading && (exists || isEditing) && (
                    <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-inset)]/30 px-6 py-2">
                        <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-[var(--accent-warm)]" />
                            <span className="text-sm font-medium text-[var(--ink)]">{activeFilename}</span>
                        </div>
                        <div className="flex items-center gap-2">
                            {isEditing ? (
                                <>
                                    {/* Delete button — only for rule files, shown in edit mode */}
                                    {!isClaudeMd && (
                                        <button
                                            type="button"
                                            onClick={() => setDeleteTarget(activeFile.type === 'rule' ? activeFile.filename : null)}
                                            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            {t('agentSettings.common.delete')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={handleCancel}
                                        className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                        {t('agentSettings.common.cancel')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSave}
                                        disabled={saving}
                                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                                    >
                                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                        {t('agentSettings.common.save')}
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleEdit}
                                    className="flex items-center gap-1 rounded-lg bg-[var(--button-dark-bg)] px-2.5 py-1 text-xs font-medium text-[var(--button-dark-text)] transition-colors hover:bg-[var(--button-dark-bg-hover)]"
                                >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    {t('agentSettings.common.edit')}
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Content Area */}
                <div className="flex-1 overflow-hidden">
                    {loading ? (
                        <div className="flex h-full items-center justify-center">
                            <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                        </div>
                    ) : !exists && !isEditing ? (
                        isClaudeMd ? (
                            // CLAUDE.md empty state — 3 visually identical cards (matches the
                            // SkillCard treatment: paper-elevated bg, rounded-xl, hover:shadow-sm,
                            // no border). Primary action is signaled by the "推荐" pill, not by
                            // a different card surface.
                            <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
                                <div className="text-center">
                                    <p className="text-lg font-semibold text-[var(--ink)]">
                                        {t('agentSettings.systemPrompts.emptyTitle')}
                                    </p>
                                    <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
                                        {t('agentSettings.systemPrompts.emptyDescription')}
                                    </p>
                                </div>
                                <div className="flex w-full max-w-xl flex-col gap-3">
                                    {onRequestInit && (
                                        <button
                                            type="button"
                                            onClick={onRequestInit}
                                            className="group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-4 py-3.5 text-left transition-shadow hover:shadow-sm"
                                        >
                                            <div className="flex items-center gap-2">
                                                <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
                                                <h4 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.systemPrompts.generateTitle')}</h4>
                                                <span className="rounded-full bg-[var(--accent-warm-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">{t('agentSettings.systemPrompts.recommended')}</span>
                                            </div>
                                            <p className="text-sm leading-relaxed text-[var(--ink-muted)]">
                                                {t('agentSettings.systemPrompts.generateDescriptionPrefix')}
                                                <code className="rounded bg-[var(--paper-inset)] px-1 text-xs">/init</code>
                                                {t('agentSettings.systemPrompts.generateDescriptionSuffix')}
                                            </p>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setTemplateDialogOpen(true)}
                                        className="group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-4 py-3.5 text-left transition-shadow hover:shadow-sm"
                                    >
                                        <div className="flex items-center gap-2">
                                            <FolderArchive className="h-4 w-4 shrink-0 text-amber-500" />
                                            <h4 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.systemPrompts.templateTitle')}</h4>
                                        </div>
                                        <p className="text-sm leading-relaxed text-[var(--ink-muted)]">
                                            {t('agentSettings.systemPrompts.templateDescription')}
                                        </p>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleEdit}
                                        className="group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-4 py-3.5 text-left transition-shadow hover:shadow-sm"
                                    >
                                        <div className="flex items-center gap-2">
                                            <Edit2 className="h-4 w-4 shrink-0 text-amber-500" />
                                            <h4 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.systemPrompts.manualTitle')}</h4>
                                        </div>
                                        <p className="text-sm leading-relaxed text-[var(--ink-muted)]">
                                            {t('agentSettings.systemPrompts.manualDescription')}
                                        </p>
                                    </button>
                                </div>
                            </div>
                        ) : (
                            // Rule file empty state — single create button (no /init or template options)
                            <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
                                <FileText className="h-16 w-16 text-[var(--ink-muted)]/30" />
                                <div className="text-center">
                                    <p className="text-sm font-medium text-[var(--ink-muted)]">
                                        {t('agentSettings.systemPrompts.ruleMissingTitle', { filename: activeFilename })}
                                    </p>
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        {t('agentSettings.systemPrompts.ruleMissingDescription')}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleEdit}
                                    className="mt-2 flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                                >
                                    <Edit2 className="h-4 w-4" />
                                    {t('agentSettings.systemPrompts.createFile', { filename: activeFilename })}
                                </button>
                            </div>
                        )
                    ) : isEditing ? (
                        <div className="h-full bg-[var(--paper)]">
                            <MonacoEditor
                                value={editContent}
                                onChange={setEditContent}
                                language="markdown"
                            />
                        </div>
                    ) : (
                        <div className="h-full overflow-auto bg-[var(--paper-elevated)] p-6">
                            {content ? (
                                // ai-message-content = 聊天正文同一 prose 上下文（16px/1.625），
                                // 替代 typography plugin 的 prose（其自带字阶与产品字阶冲突，
                                // PRD 0.2.34 Part 2 F4）。Markdown 组件自带全部元素样式。
                                <div className="ai-message-content">
                                    <Markdown raw>{content}</Markdown>
                                </div>
                            ) : (
                                <span className="text-sm text-[var(--ink-muted)]/60">
                                    {t('agentSettings.common.emptyContent')}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* Delete Confirmation */}
                {deleteTarget && (
                    <ConfirmDialog
                        title={t('agentSettings.systemPrompts.deleteTitle')}
                        message={t('agentSettings.systemPrompts.deleteMessage', { filename: deleteTarget })}
                        confirmText={t('agentSettings.common.delete')}
                        confirmVariant="danger"
                        onConfirm={handleDeleteConfirm}
                        onCancel={() => setDeleteTarget(null)}
                    />
                )}

                {/* Template apply dialog (CLAUDE.md empty state → "从模板库添加") */}
                {templateDialogOpen && (
                    <TemplateApplyDialog
                        agentDir={agentDir}
                        onClose={() => setTemplateDialogOpen(false)}
                        onApplied={() => {
                            // Force-switch to CLAUDE.md before reloading: today the dialog can
                            // only be opened from the CLAUDE.md empty state, but `loadFileContent`
                            // writes into the shared `content`/`editContent` state that's keyed
                            // off `activeFile`. If a future entry point opens the dialog while a
                            // rule tab is active, an unguarded reload would silently overwrite
                            // the rule's content with CLAUDE.md text. Setting activeFile first
                            // makes the load self-consistent.
                            setActiveFile({ type: 'claude-md' });
                            void loadFileContent({ type: 'claude-md' });
                            void loadRuleFiles();
                            toastRef.current.success(tRef.current('agentSettings.systemPrompts.templateApplied'));
                        }}
                    />
                )}
            </div>
        );
    });

export default SystemPromptsPanel;
