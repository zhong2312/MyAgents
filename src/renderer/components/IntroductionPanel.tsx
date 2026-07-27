/**
 * IntroductionPanel — Manages INTRODUCTION.md for workspace welcome content.
 * Supports three states: file not found (with create CTA), preview, and editing.
 *
 * Uses Rust IPC (cmd_read/write/delete_workspace_file) — no Sidecar dependency.
 * Pattern follows SystemPromptsPanel (preview/edit toggle, isEditing guard, MonacoEditor).
 */
import { Save, Edit2, X, FileText, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useImperativeHandle, forwardRef, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';

import { useToast } from '@/components/Toast';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import ConfirmDialog from '@/components/ConfirmDialog';

interface IntroductionPanelProps {
  agentDir: string;
}

export interface IntroductionPanelRef {
  isEditing: () => boolean;
}

const FILENAME = 'INTRODUCTION.md';
// Seed file content is workspace data, not UI chrome; keep the existing preset as-is.
const DEFAULT_INTRODUCTION_TEMPLATE = '# Agent 名称\n\n在这里编写使用指南，用户打开新对话时将看到此内容。\n';

const IntroductionPanel = forwardRef<IntroductionPanelRef, IntroductionPanelProps>(
  function IntroductionPanel({ agentDir }, ref) {
    const { t } = useTranslation('settings');
    const toast = useToast();
    const toastRef = useRef(toast);
    useEffect(() => { toastRef.current = toast; }, [toast]);
    const tRef = useRef(t);
    tRef.current = t;

    const isMountedRef = useRef(true);
    useEffect(() => () => { isMountedRef.current = false; }, []);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [content, setContent] = useState('');
    const [editContent, setEditContent] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [exists, setExists] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false);

    useImperativeHandle(ref, () => ({
      isEditing: () => isEditing,
    }), [isEditing]);

    const filePath = useMemo(() => {
      const sep = agentDir.includes('\\') ? '\\' : '/';
      return `${agentDir}${sep}${FILENAME}`;
    }, [agentDir]);

    // Load file content
    const loadContent = useCallback(async () => {
      setLoading(true);
      try {
        const result = await invoke<string | null>('cmd_read_workspace_file', { path: filePath });
        if (!isMountedRef.current) return;
        if (result !== null) {
          setContent(result);
          setEditContent(result);
          setExists(true);
        } else {
          setContent('');
          setEditContent('');
          setExists(false);
        }
      } catch {
        if (!isMountedRef.current) return;
        setContent('');
        setEditContent('');
        setExists(false);
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    }, [filePath]);

    // Initial load
    useEffect(() => { loadContent(); }, [loadContent]);

    // Edit mode handlers
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
        await invoke('cmd_write_workspace_file', { path: filePath, content: editContent });
        if (!isMountedRef.current) return;
        setContent(editContent);
        setExists(true);
        setIsEditing(false);
        toastRef.current.success(tRef.current('agentSettings.introduction.saveSuccess'));
      } catch (err) {
        if (!isMountedRef.current) return;
        toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.saveFailed'));
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    }, [editContent, filePath]);

    // Create (with default template)
    const handleCreate = useCallback(async () => {
      setEditContent(DEFAULT_INTRODUCTION_TEMPLATE);
      setIsEditing(true);
    }, []);

    // Delete
    const handleDelete = useCallback(async () => {
      try {
        await invoke<boolean>('cmd_delete_workspace_file', { path: filePath });
        if (!isMountedRef.current) return;
        setContent('');
        setEditContent('');
        setExists(false);
        setIsEditing(false);
        setDeleteConfirm(false);
        toastRef.current.success(tRef.current('agentSettings.introduction.deleteSuccess'));
      } catch (err) {
        if (!isMountedRef.current) return;
        toastRef.current.error(err instanceof Error ? err.message : tRef.current('agentSettings.common.deleteFailed'));
        setDeleteConfirm(false);
      }
    }, [filePath]);

    return (
      <div className="flex h-full flex-col">
        {/* Action Bar */}
        {!loading && (exists || isEditing) && (
          <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-inset)]/30 px-6 py-2">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-[var(--accent-warm)]" />
              <span className="text-sm font-medium text-[var(--ink)]">{FILENAME}</span>
            </div>
            <div className="flex items-center gap-2">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('agentSettings.common.delete')}
                  </button>
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
                <>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('agentSettings.common.delete')}
                  </button>
                  <button
                    type="button"
                    onClick={handleEdit}
                    className="flex items-center gap-1 rounded-lg bg-[var(--button-dark-bg)] px-2.5 py-1 text-xs font-medium text-[var(--button-dark-text)] transition-colors hover:bg-[var(--button-dark-bg-hover)]"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                    {t('agentSettings.common.edit')}
                  </button>
                </>
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
            // Mirrors the SystemPromptsPanel CLAUDE.md empty state — single "手动创建"
            // card here since INTRODUCTION.md has no AI-generation or template paths.
            <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
              <div className="text-center">
                <p className="text-lg font-semibold text-[var(--ink)]">
                  {t('agentSettings.introduction.emptyTitle')}
                </p>
                <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
                  {t('agentSettings.introduction.emptyDescription')}
                </p>
              </div>
              <div className="flex w-full max-w-xl flex-col gap-3">
                <button
                  type="button"
                  onClick={handleCreate}
                  className="group flex cursor-pointer flex-col gap-1.5 rounded-xl bg-[var(--paper-elevated)] px-4 py-3.5 text-left transition-shadow hover:shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <Edit2 className="h-4 w-4 shrink-0 text-amber-500" />
                    <h4 className="text-base font-semibold text-[var(--ink)]">{t('agentSettings.introduction.manualTitle')}</h4>
                  </div>
                  <p className="text-sm leading-relaxed text-[var(--ink-muted)]">
                    {t('agentSettings.introduction.manualDescription')}
                  </p>
                </button>
              </div>
            </div>
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
              {content.trim() ? (
                <div className="introduction-content">
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
        {deleteConfirm && (
          <ConfirmDialog
            title={t('agentSettings.introduction.deleteTitle')}
            message={t('agentSettings.introduction.deleteMessage', { filename: FILENAME })}
            confirmText={t('agentSettings.common.delete')}
            confirmVariant="danger"
            onConfirm={handleDelete}
            onCancel={() => setDeleteConfirm(false)}
          />
        )}
      </div>
    );
  },
);

export default IntroductionPanel;
