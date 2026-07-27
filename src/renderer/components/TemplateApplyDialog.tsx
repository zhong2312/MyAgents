/**
 * TemplateApplyDialog — pick a template and merge it into the CURRENT workspace.
 *
 * Counterpart to `launcher/TemplateLibraryDialog.tsx` (which creates a NEW workspace).
 * The two have separate UIs because the two flows have meaningfully different inputs:
 * create-workspace asks for a target dir + project name + icon; apply-to-current uses
 * the existing agentDir as-is and just needs template selection + overwrite confirmation.
 *
 * Two-step UX:
 *   1. List templates → select one → click "应用".
 *   2. Backend `cmd_template_apply_preview` returns the file overwrite/add lists →
 *      a confirmation view shows what will be written. User confirms → backend
 *      `cmd_apply_template_to_workspace` performs the merge.
 *
 * Same-name files in the workspace are overwritten; everything else is preserved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle, FilePlus, FileWarning, ArrowLeft } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

import type { WorkspaceTemplate } from '@/config/types';
import { PRESET_TEMPLATES } from '@/config/types';
import { loadUserTemplates } from '@/config/services/templateService';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import WorkspaceIcon from './launcher/WorkspaceIcon';

interface TemplateApplyDialogProps {
    /** Workspace path that the template will be merged into. */
    agentDir: string;
    onClose: () => void;
    /** Called after a successful apply so the caller can refresh content. */
    onApplied?: () => void;
}

interface ApplyPreview {
    overwrite: string[];
    add: string[];
}

type Step = 'pick' | 'confirm';

export default function TemplateApplyDialog({ agentDir, onClose, onApplied }: TemplateApplyDialogProps) {
    const { t: tSettings } = useTranslation('settings');
    // Block dismissal (Cmd+W / backdrop / Esc) while an apply is in flight — letting the
    // component unmount mid-merge would invoke `onApplied` after unmount AND leave the
    // user without feedback while files keep being written. `applyInFlightRef` is consulted
    // by `handleClose` below.
    const applyInFlightRef = useRef(false);
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const handleClose = useCallback(() => {
        if (applyInFlightRef.current) return; // ignore while applying
        onClose();
    }, [onClose]);

    useCloseLayer(() => { handleClose(); return true; }, 220);

    const [step, setStep] = useState<Step>('pick');
    const [templates, setTemplates] = useState<WorkspaceTemplate[]>([...PRESET_TEMPLATES]);
    const [selectedId, setSelectedId] = useState<string>(PRESET_TEMPLATES[0]?.id ?? '');
    const [loading, setLoading] = useState(false);      // preview / apply in flight
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<ApplyPreview | null>(null);

    // Load user templates alongside bundled ones
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const userTemplates = await loadUserTemplates();
                if (!cancelled && isMountedRef.current) setTemplates([...PRESET_TEMPLATES, ...userTemplates]);
            } catch (err) {
                console.warn('[TemplateApply] Failed to load user templates:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const selectedTemplate = templates.find(t => t.id === selectedId) ?? null;

    /** Build the invoke args object for both preview and apply commands. Single source of
     *  truth for the bundled (`templateId`) vs user (`sourcePath`) branch. */
    const buildInvokeArgs = useCallback((tpl: WorkspaceTemplate): Record<string, unknown> => {
        const args: Record<string, unknown> = { destPath: agentDir };
        if (tpl.isBuiltin) {
            args.templateId = tpl.id;
        } else if (tpl.path) {
            args.sourcePath = tpl.path;
        } else {
            throw new Error('Template has no source path');
        }
        return args;
    }, [agentDir]);

    /** Step 1 → 2: ask the backend which files would be overwritten. */
    const handleRequestApply = useCallback(async () => {
        if (!selectedTemplate) return;
        setLoading(true);
        setError(null);
        try {
            const result = await invoke<ApplyPreview>('cmd_template_apply_preview', buildInvokeArgs(selectedTemplate));
            if (!isMountedRef.current) return;
            setPreview(result);
            setStep('confirm');
        } catch (err) {
            if (isMountedRef.current) setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (isMountedRef.current) setLoading(false);
        }
    }, [selectedTemplate, buildInvokeArgs]);

    /** Step 2: user confirmed — perform the merge. Guarded against double-submit by
     *  `applyInFlightRef` (synchronous, unlike the async `loading` state which doesn't
     *  disable the button until the next render). */
    const handleConfirmApply = useCallback(async () => {
        if (!selectedTemplate) return;
        if (applyInFlightRef.current) return;
        applyInFlightRef.current = true;
        setLoading(true);
        setError(null);
        try {
            await invoke('cmd_apply_template_to_workspace', buildInvokeArgs(selectedTemplate));
            onApplied?.();
            // Don't gate `onClose` on mount — even if the parent unmounted us, calling
            // onClose is a no-op on a stale handler.
            onClose();
        } catch (err) {
            if (isMountedRef.current) {
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            }
        } finally {
            applyInFlightRef.current = false;
        }
    }, [selectedTemplate, buildInvokeArgs, onApplied, onClose]);

    return (
        <OverlayBackdrop onClose={handleClose} className="z-[220]">
            <div className="flex w-[560px] max-h-[78vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
                    <div className="flex items-center gap-3">
                        {step === 'confirm' && (
                            <button
                                type="button"
                                onClick={() => { setStep('pick'); setPreview(null); setError(null); }}
                                className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                title={tSettings('agentSettings.templateApply.back')}
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </button>
                        )}
                        <h2 className="text-lg font-semibold text-[var(--ink)]">
                            {step === 'pick'
                                ? tSettings('agentSettings.templateApply.pickTitle')
                                : tSettings('agentSettings.templateApply.confirmTitle')}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={handleClose}
                        disabled={loading}
                        title={tSettings('agentSettings.templateApply.close')}
                        className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-auto px-6 py-4">
                    {step === 'pick' ? (
                        <ul className="flex flex-col gap-2">
                            {templates.map(tpl => {
                                const active = tpl.id === selectedId;
                                return (
                                    <li key={tpl.id}>
                                        <button
                                            type="button"
                                            onClick={() => setSelectedId(tpl.id)}
                                            className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-all ${
                                                active
                                                    ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)]'
                                                    : 'border-[var(--line)] hover:border-[var(--line-strong)] hover:bg-[var(--paper-inset)]'
                                            }`}
                                        >
                                            <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--paper)]">
                                                <WorkspaceIcon icon={tpl.icon} size={20} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium text-[var(--ink)]">{tpl.name}</span>
                                                    {tpl.isBuiltin && (
                                                        <span className="rounded px-1.5 py-0.5 text-xs text-[var(--ink-muted)] bg-[var(--paper-inset)]">
                                                            {tSettings('agentSettings.templateApply.builtin')}
                                                        </span>
                                                    )}
                                                </div>
                                                {tpl.description && (
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)] leading-relaxed">{tpl.description}</p>
                                                )}
                                            </div>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <div className="flex flex-col gap-4">
                            <p className="text-sm text-[var(--ink-muted)]">
                                {tSettings('agentSettings.templateApply.confirmMerge', { name: selectedTemplate?.name ?? '' })}
                            </p>
                            {preview && preview.overwrite.length > 0 && (
                                <section>
                                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--warning)]">
                                        <FileWarning className="h-3.5 w-3.5" />
                                        {tSettings('agentSettings.templateApply.overwriteFiles', { count: preview.overwrite.length })}
                                    </h3>
                                    <ul className="max-h-[180px] overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 font-mono text-xs text-[var(--ink-muted)]">
                                        {preview.overwrite.map(f => <li key={f} className="py-0.5">{f}</li>)}
                                    </ul>
                                </section>
                            )}
                            {preview && preview.add.length > 0 && (
                                <section>
                                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--ink-secondary)]">
                                        <FilePlus className="h-3.5 w-3.5" />
                                        {tSettings('agentSettings.templateApply.addFiles', { count: preview.add.length })}
                                    </h3>
                                    <ul className="max-h-[180px] overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 font-mono text-xs text-[var(--ink-muted)]">
                                        {preview.add.map(f => <li key={f} className="py-0.5">{f}</li>)}
                                    </ul>
                                </section>
                            )}
                            {preview && preview.overwrite.length === 0 && preview.add.length === 0 && (
                                <p className="text-xs text-[var(--ink-muted)]">{tSettings('agentSettings.templateApply.empty')}</p>
                            )}
                        </div>
                    )}
                </div>

                {/* Error */}
                {error && (
                    <div className="mx-6 mb-2 flex items-start gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-3">
                    <button
                        type="button"
                        onClick={handleClose}
                        disabled={loading}
                        className="rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
                    >
                        {tSettings('agentSettings.templateApply.cancel')}
                    </button>
                    {step === 'pick' ? (
                        <button
                            type="button"
                            onClick={handleRequestApply}
                            disabled={loading || !selectedTemplate}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
                        >
                            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                            {tSettings('agentSettings.templateApply.next')}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={handleConfirmApply}
                            disabled={loading || !preview || (preview.overwrite.length === 0 && preview.add.length === 0)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
                        >
                            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                            {tSettings('agentSettings.templateApply.confirmApply')}
                        </button>
                    )}
                </div>
            </div>
        </OverlayBackdrop>
    );
}
