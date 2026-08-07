// SettingsHelperInbox — inline MA helper invocation entry on the Providers
// settings page. Mounted only when the user has at least one usable provider
// (mirrors the existing `showAiInstallButton` gate). Acts as the visual
// "main entry" of the settings experience: a large textarea + model picker
// + send button that dispatches LAUNCH_BUG_REPORT, the same event consumed
// by App.tsx to spin up a helper conversation tab.
//
// Visuals follow specs/DESIGN.md v2.2 §6 component tokens; see
// specs/prd/prd_0.2.7_providers_helper_inline_entry.md §3.3 for the full
// design rationale.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, Loader2, Paperclip, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Provider, ProviderVerifyStatus } from '@/config/types';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useImageAttachments } from '@/hooks/useImageAttachments';
import { HelperModelPicker, resolveInitialHelperModel } from '@/components/HelperModelPicker';
import SessionHistoryDropdown from '@/components/SessionHistoryDropdown';
import { dispatchHelperRequest } from '@/utils/dispatchHelperRequest';
import { track } from '@/analytics';
import Tip from '@/components/Tip';
import { useConfigData } from '@/config/useConfigData';
import { useConfigActions } from '@/config/useConfigActions';
import { ensureSelfAwarenessWorkspace } from '@/config/configService';
import { useChatComposerKeydown } from '@/hooks/useChatComposerKeydown';
import { sendKeyHint } from '@/utils/chatSendKey';

interface SettingsHelperInboxProps {
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    appVersion: string;
    /** Helper Agent's persisted default — initial picker selection. */
    initialProviderId?: string;
    initialModel?: string;
    /** Persist user's picker change back to the helper Agent. */
    onModelChange?: (providerId: string, model: string) => void;
}

export default function SettingsHelperInbox({
    providers,
    apiKeys,
    providerVerifyStatus,
    appVersion,
    initialProviderId,
    initialModel,
    onModelChange,
}: SettingsHelperInboxProps) {
    const { t } = useTranslation('settings');
    const [text, setText] = useState('');
    const [isSending, setIsSending] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { openPreview } = useImagePreview();

    // History popover state. agentDir is derived from projects (single source
    // of truth — disk via ConfigProvider). Helper project may not exist yet
    // if user has never sent a message; in that case we lazily ensure on the
    // first 历史 click rather than eagerly creating it on Settings open.
    const [showHistory, setShowHistory] = useState(false);
    const historyBtnRef = useRef<HTMLButtonElement>(null);
    // Synchronous in-flight latch — same shape as `sendingRef` below. Blocks
    // double-click race that would otherwise fire two parallel ensureSelf-
    // AwarenessWorkspace calls before ConfigProvider's setProjects commit.
    const historyEnsuringRef = useRef(false);
    const { projects } = useConfigData();
    const { addProject, patchProject } = useConfigActions();

    const helperAgentDir = useMemo(() => {
        const helperProject = projects.find(p => p.internal === true);
        return helperProject?.path ?? '';
    }, [projects]);

    const handleHistoryClick = useCallback(async () => {
        if (showHistory) {
            setShowHistory(false);
            return;
        }
        if (!helperAgentDir) {
            if (historyEnsuringRef.current) return;
            historyEnsuringRef.current = true;
            try {
                // Lazy ensure — addProject mutates ConfigProvider state, so the
                // useMemo above re-derives agentDir on the next render after this
                // await resolves. Dropdown then mounts with a real agentDir and
                // surfaces the standard "暂无历史记录" empty state.
                const project = await ensureSelfAwarenessWorkspace(projects, addProject, patchProject);
                if (!project) {
                    console.warn('[SettingsHelperInbox] ensureSelfAwarenessWorkspace returned null');
                    return;
                }
            } finally {
                historyEnsuringRef.current = false;
            }
            // Settings panel may have closed during the await — bail before
            // touching state on an unmounted component (project red line).
            if (!mountedRef.current) return;
        }
        setShowHistory(true);
    }, [showHistory, helperAgentDir, projects, addProject, patchProject]);

    const handleSelectHistorySession = useCallback((sessionId: string) => {
        setShowHistory(false);
        // Empty description + resumeSessionId routes through the canonical
        // existing-Session new/jump/revive owner and skips auto-send.
        dispatchHelperRequest({ description: '', appVersion, resumeSessionId: sessionId });
    }, [appVersion]);

    const {
        images,
        addFile,
        removeAt,
        clear: clearImages,
        isDragging,
        dragHandlers,
        pasteHandler,
    } = useImageAttachments();

    // Picker selection is a pure view of the helper Agent's persisted
    // (providerId, model). User picks → onModelChange → patchAgentConfig
    // writes disk → useConfigData refresh flows back through
    // initialProviderId/initialModel props → this useMemo re-derives.
    //
    // Deriving instead of useState + useEffect avoids React's
    // set-state-in-effect rule (per react_stability_rules) and removes the
    // "two sources of truth" hazard — disk is canonical, which matches
    // BugReportOverlay's existing single-source semantics. Trade-off: a
    // small (~one-frame) optimistic UI gap during the disk round-trip,
    // which is acceptable since model picks are not high-frequency.
    const picked = useMemo(
        () =>
            resolveInitialHelperModel(providers, apiKeys, providerVerifyStatus, {
                providerId: initialProviderId,
                model: initialModel,
            }),
        [providers, apiKeys, providerVerifyStatus, initialProviderId, initialModel],
    );

    // Synchronous send guard. `isSending` (state) is fine for visuals but
    // can't block a same-frame double Cmd+Enter — the disabled prop and
    // canSend closure both trail one render. sendingRef trips immediately.
    const sendingRef = useRef(false);
    const mountedRef = useRef(true);
    const sendingTimerRef = useRef<number | null>(null);
    useEffect(() => () => {
        mountedRef.current = false;
        if (sendingTimerRef.current !== null) {
            window.clearTimeout(sendingTimerRef.current);
            sendingTimerRef.current = null;
        }
    }, []);

    const hasContent = text.trim().length > 0 || images.length > 0;
    const hasValidModel = !!picked.providerId && !!picked.model;
    const canSend = hasContent && hasValidModel && !isSending;

    const isMac = useMemo(() => navigator.platform.toLowerCase().includes('mac'), []);

    const handleSend = useCallback(() => {
        if (!canSend) return;
        if (sendingRef.current) return;
        sendingRef.current = true;
        setIsSending(true);
        track('bug_report_submit', { has_screenshot: images.length > 0 });
        dispatchHelperRequest({
            description: text,
            providerId: picked.providerId,
            model: picked.model,
            appVersion,
            images,
            assistantEntry: 'settings',
        });
        // Local state reset; the LAUNCH_BUG_REPORT handler in App.tsx spins
        // up a helper Tab and consumes the payload. The user's view jumps
        // to the new Tab, so this component effectively unmounts soon
        // after — the timeout is a safety net for the (rare) case the user
        // returns immediately without tab activation remounting us.
        setText('');
        clearImages();
        if (sendingTimerRef.current !== null) window.clearTimeout(sendingTimerRef.current);
        sendingTimerRef.current = window.setTimeout(() => {
            sendingTimerRef.current = null;
            sendingRef.current = false;
            if (mountedRef.current) setIsSending(false);
        }, 400);
    }, [canSend, text, picked, appVersion, images, clearImages]);

    // Send-key behavior follows the user's chatSendShortcut preference (shared
    // with the main chat box). The hook also supplies the IME composition
    // handlers this inbox previously lacked. handleSend self-guards on canSend.
    const { onKeyDown: handleKeyDown, onCompositionStart, onCompositionEnd, sendShortcut } =
        useChatComposerKeydown(handleSend);

    const submitTip = useMemo(() => {
        if (!hasContent) return { label: t('helper.emptyTip'), shortcut: undefined };
        if (!hasValidModel) return { label: t('helper.configureModelTip'), shortcut: undefined };
        return { label: t('helper.send'), shortcut: sendKeyHint(sendShortcut, isMac).shortcut };
    }, [hasContent, hasValidModel, isMac, sendShortcut, t]);

    return (
        <div className="mb-8">
            {/* Title matches the "模型供应商" h2 below — same visual weight to
                signal "this is a peer section, not a subtitle". 历史 button
                on the right reuses Chat tab's SessionHistoryDropdown so users
                can jump into past helper conversations without first opening
                a Tab. (Issue #120) */}
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-[var(--ink)]">
                    {t('helper.title')}
                </h2>
                <button
                    ref={historyBtnRef}
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={handleHistoryClick}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium transition-colors ${
                        showHistory
                            ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                >
                    <History className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>{t('helper.history')}</span>
                </button>
                {helperAgentDir && (
                    <SessionHistoryDropdown
                        agentDir={helperAgentDir}
                        currentSessionId={null}
                        onSelectSession={handleSelectHistorySession}
                        isOpen={showHistory}
                        onClose={() => setShowHistory(false)}
                        triggerRef={historyBtnRef}
                    />
                )}
            </div>
            {/* Container has no padding — textarea zone and toolbar zone
                each carry their own. This keeps the toolbar's vertical
                padding symmetric (py-2) so the buttons sit centered in the
                toolbar row instead of hugging the divider. */}
            <div
                className={`relative overflow-hidden rounded-[var(--radius-xl)] bg-[var(--paper-elevated)] shadow-xs transition-shadow duration-150 hover:shadow-sm focus-within:shadow-sm ${
                    isDragging ? 'ring-2 ring-[var(--accent-warm)]/40' : ''
                } ${isSending ? 'pointer-events-none opacity-70' : ''}`}
                {...dragHandlers}
            >
                <div className="px-5 pt-5 pb-3">
                    {/* text-base（非 text-[var(--text-base)]——后者被 Tailwind 解析成
                        color 而非 font-size，字号声明静默失效，cross-review 编译产物取证）；
                        maxHeight 用配对行高 var 与字阶同源，token 调整自动跟随 */}
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onCompositionStart={onCompositionStart}
                        onCompositionEnd={onCompositionEnd}
                        onPaste={pasteHandler}
                        placeholder={t('helper.placeholder')}
                        rows={4}
                        className="w-full resize-none overflow-y-auto border-0 bg-transparent text-base text-[var(--ink)] caret-[var(--accent-warm)] placeholder:text-[var(--ink-muted)] focus:outline-none"
                        style={{ maxHeight: 'calc(8 * var(--text-base--line-height) * var(--text-base))' }}
                    />

                    {images.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {images.map((img) => (
                                <div key={img.id} className="group/thumb relative">
                                    <img
                                        src={img.preview}
                                        alt={t('helper.attachmentAlt')}
                                        className="h-16 w-16 cursor-pointer rounded-[var(--radius-md)] object-cover"
                                        onDoubleClick={() => openPreview(img.preview, img.file.name)}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removeAt(img.id)}
                                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--ink)]/70 text-[var(--paper)] opacity-0 transition-all hover:bg-[var(--ink)] group-hover/thumb:opacity-100"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                        for (const file of Array.from(e.target.files || [])) addFile(file);
                        e.target.value = '';
                    }}
                />

                {/* Toolbar layout mirrors SimpleChatInput (chat input):
                    secondary tools on the left (attachment), primary
                    actions clustered on the right (model picker + send),
                    so users see the same affordance shape across surfaces. */}
                <div className="flex items-center justify-between border-t border-[var(--line-subtle)] px-5 py-2">
                    <div className="flex items-center gap-1">
                        <Tip label={t('helper.addImage')} position="top">
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="flex items-center rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                                <Paperclip className="h-3.5 w-3.5" />
                            </button>
                        </Tip>
                    </div>

                    <div className="flex items-center gap-1">
                        <HelperModelPicker
                            providers={providers}
                            apiKeys={apiKeys}
                            verifyStatus={providerVerifyStatus}
                            value={picked}
                            placement="top-end"
                            onChange={(providerId, model) => {
                                // Persist to helper agent — disk state is the
                                // single source of truth; the useMemo above
                                // re-derives `picked` once useConfigData
                                // surfaces the change.
                                onModelChange?.(providerId, model);
                            }}
                        />
                        <Tip label={submitTip.label} shortcut={submitTip.shortcut} position="top" align="end">
                            <button
                                type="button"
                                onClick={handleSend}
                                disabled={!canSend}
                                className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-3.5 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isSending ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Send className="h-3.5 w-3.5" />
                                )}
                                {t('helper.send')}
                            </button>
                        </Tip>
                    </div>
                </div>
            </div>
        </div>
    );
}
