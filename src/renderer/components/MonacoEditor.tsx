/**
 * MonacoEditor - Lightweight Monaco Editor wrapper for file editing
 * 
 * Features:
 * - Auto language detection based on file extension
 * - Custom warm theme matching preview background
 * - Optimized for performance (minimal features enabled)
 * - Loading state handling
 * - Local bundle (no CDN) for Tauri CSP compatibility
 */
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import { ClipboardPaste, Copy, Loader2, Quote, Scissors, Search, TextSelect } from 'lucide-react';
import * as monaco from 'monaco-editor';
import { retainFocusOnMouseDown } from '@/utils/focusRetention';
import {
    closestMonacoFindButton,
    computeMonacoFindTooltipPosition,
    resolveMonacoFindTooltipLabel,
} from '@/utils/monacoFindTooltip';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// CRITICAL: Must import Monaco CSS for styles to work in Vite bundled mode
import 'monaco-editor/min/vs/editor/editor.main.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useResolvedTheme } from '@/theme';
import { copyPlainText } from '@/utils/clipboard';
import type { FilePreviewFocusTarget } from '@/types/filePreview';

// Configure Monaco Environment for bundled workers (required for Tauri CSP)
self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
        if (label === 'json') {
            return new jsonWorker();
        }
        if (label === 'css' || label === 'scss' || label === 'less') {
            return new cssWorker();
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return new htmlWorker();
        }
        if (label === 'typescript' || label === 'javascript') {
            return new tsWorker();
        }
        return new editorWorker();
    }
};

// Configure Monaco to use local bundle instead of CDN
loader.config({ monaco });

function safeMonacoThemeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

// Re-export language utilities from shared module for backward compatibility
export { getMonacoLanguage, shouldShowLineNumbers } from '@/utils/languageUtils';

/** Selection payload emitted by `onQuote`. Lines are already trimmed of leading/trailing
 *  blank-only lines and `endLine` is decremented when the selection ends at column 1
 *  (i.e. user dragged to the start of the next line but didn't include any text from it). */
export interface MonacoQuoteSelection {
    text: string;
    startLine: number;
    endLine: number;
}

interface MonacoEditorProps {
    value: string;
    onChange: (value: string) => void;
    language?: string;
    readOnly?: boolean;
    className?: string;
    /** Auto focus the editor when mounted */
    autoFocus?: boolean;
    /** Cmd/Ctrl+S handler — registered as Monaco keybinding */
    onSave?: () => void;
    /** Initial line to scroll to and select */
    initialLineNumber?: number;
    /** Search/file-link navigation target. Unlike initialLineNumber this is an event:
     *  a new requestId must re-center even when the line number did not change. */
    focusTarget?: FilePreviewFocusTarget;
    /** When provided, a floating「引用」button appears above any non-empty selection.
     *  Clicking it calls back with the selection's text + 1-based line range, then clears
     *  the selection. When omitted, no quote affordance is rendered (Monaco-side default). */
    onQuote?: (selection: MonacoQuoteSelection) => void;
    /** Soft-wrap mode. Default `'on'`. Pass `'off'` for files with pathologically
     *  long lines (data / minified JSON): Monaco's `wrappingStrategy: 'advanced'`
     *  font-measured wrap of a 30k+ char line is the dominant load cost, and such
     *  lines are unreadable wrapped anyway — horizontal scroll is both faster and
     *  more appropriate. Normal prose (short lines) keeps wrapping. */
    wordWrap?: 'on' | 'off';
}

export default function MonacoEditor({
    value,
    onChange,
    language = 'plaintext',
    readOnly = false,
    className = '',
    autoFocus = false,
    onSave,
    initialLineNumber,
    focusTarget,
    onQuote,
    wordWrap = 'on',
}: MonacoEditorProps) {
    const { t } = useTranslation('app');
    const handleChange = useCallback((newValue: string | undefined) => {
        onChange(newValue ?? '');
    }, [onChange]);

    const resolvedTheme = useResolvedTheme();
    const monacoTheme = resolvedTheme.adapters.monaco;
    const activeTheme = useMemo(
        () => `myagents-${safeMonacoThemeSegment(resolvedTheme.themeId)}-${safeMonacoThemeSegment(monacoTheme.name)}`,
        [monacoTheme.name, resolvedTheme.themeId],
    );

    const handleBeforeMount = useCallback((monacoInstance: Monaco) => {
        monacoInstance.editor.defineTheme(activeTheme, monacoTheme.data);
    }, [activeTheme, monacoTheme.data]);

    // Monaco's registry is process-global. Redefine + select the resolved
    // adapter in place so open editors retain their model, selection and undo
    // stack across Theme changes.
    useEffect(() => {
        monaco.editor.defineTheme(activeTheme, monacoTheme.data);
        monaco.editor.setTheme(activeTheme);
    }, [activeTheme, monacoTheme.data]);

    // Stable ref for onSave to avoid re-registering keybinding on every render
    const onSaveRef = useRef(onSave);
    useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

    // Stable ref for onQuote — listener is registered once at mount but caller's callback
    // identity may change across renders (e.g. when path/onQuoteSelection change in parent).
    const onQuoteRef = useRef(onQuote);
    useEffect(() => { onQuoteRef.current = onQuote; }, [onQuote]);

    // Selection-quote menu state (ignored when onQuote is undefined). Editor instance held
    // in a ref because we need to query selection at click time outside React effects.
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const [quoteMenu, setQuoteMenu] = useState<{ x: number; y: number; above: boolean } | null>(null);
    const quoteRafRef = useRef<number | null>(null);
    const focusDecorationIdsRef = useRef<string[]>([]);
    const focusClearTimerRef = useRef<number | null>(null);
    const focusMountTimerRef = useRef<number | null>(null);
    const focusTargetRef = useRef(focusTarget);
    const lastAppliedFocusTargetRef = useRef<FilePreviewFocusTarget | null>(null);
    const [findTooltip, setFindTooltip] = useState<{ label: string; x: number; top: number } | null>(null);
    const findTooltipTimerRef = useRef<number | null>(null);
    const activeFindTooltipButtonRef = useRef<HTMLElement | null>(null);
    useEffect(() => { focusTargetRef.current = focusTarget; }, [focusTarget]);

    const clearFindTooltipTimer = useCallback(() => {
        if (findTooltipTimerRef.current !== null) {
            window.clearTimeout(findTooltipTimerRef.current);
            findTooltipTimerRef.current = null;
        }
    }, []);

    const hideFindTooltip = useCallback(() => {
        clearFindTooltipTimer();
        activeFindTooltipButtonRef.current = null;
        setFindTooltip(null);
    }, [clearFindTooltipTimer]);

    const showFindTooltipForButton = useCallback((button: HTMLElement) => {
        const label = resolveMonacoFindTooltipLabel(button);
        if (!label) {
            hideFindTooltip();
            return;
        }

        const position = computeMonacoFindTooltipPosition(button.getBoundingClientRect(), {
            width: window.innerWidth,
            height: window.innerHeight,
        });
        setFindTooltip({ label, ...position });
    }, [hideFindTooltip]);

    const scheduleFindTooltip = useCallback((button: HTMLElement) => {
        clearFindTooltipTimer();
        activeFindTooltipButtonRef.current = button;
        findTooltipTimerRef.current = window.setTimeout(() => {
            findTooltipTimerRef.current = null;
            if (activeFindTooltipButtonRef.current === button) {
                showFindTooltipForButton(button);
            }
        }, 180);
    }, [clearFindTooltipTimer, showFindTooltipForButton]);

    const clearPendingFocusTimer = useCallback(() => {
        if (focusMountTimerRef.current !== null) {
            window.clearTimeout(focusMountTimerRef.current);
            focusMountTimerRef.current = null;
        }
    }, []);

    const clearFocusDecoration = useCallback((editor = editorRef.current) => {
        if (focusClearTimerRef.current !== null) {
            window.clearTimeout(focusClearTimerRef.current);
            focusClearTimerRef.current = null;
        }
        if (editor && focusDecorationIdsRef.current.length > 0) {
            focusDecorationIdsRef.current = editor.deltaDecorations(focusDecorationIdsRef.current, []);
        } else {
            focusDecorationIdsRef.current = [];
        }
    }, []);

    const applyFocusTarget = useCallback((target: FilePreviewFocusTarget): boolean => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!editor || !model || target.lineNumber < 1) return false;

        const lineNumber = Math.max(1, Math.min(target.lineNumber, model.getLineCount()));
        const firstHighlight = target.highlights?.[0];
        const column = firstHighlight
            ? Math.max(1, Math.min(firstHighlight[0] + 1, model.getLineMaxColumn(lineNumber)))
            : 1;

        editor.revealLineInCenter(lineNumber);
        editor.setPosition({ lineNumber, column });
        clearFocusDecoration(editor);
        focusDecorationIdsRef.current = editor.deltaDecorations([], [
            {
                range: new monaco.Range(lineNumber, 1, lineNumber, 1),
                options: {
                    isWholeLine: true,
                    className: 'myagents-monaco-search-focus-line',
                },
            },
        ]);
        focusClearTimerRef.current = window.setTimeout(() => {
            if (editorRef.current === editor) {
                clearFocusDecoration(editor);
            }
        }, 1800);
        return true;
    }, [clearFocusDecoration]);

    /** Compute viewport coords for the quote menu given a current non-empty selection.
     *  Mirrors SelectionCommentMenu's positioning: anchor at start of selection, prefer
     *  above; fall back below when too close to viewport top. Returns null when the
     *  selection is empty / off-screen / editor is unmounted. */
    const computeQuoteMenuPosition = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
        const sel = editor.getSelection();
        if (!sel || sel.isEmpty()) return null;
        const editorEl = editor.getDomNode();
        if (!editorEl) return null;
        const local = editor.getScrolledVisiblePosition({
            lineNumber: sel.startLineNumber,
            column: sel.startColumn,
        });
        if (!local) return null;
        const editorRect = editorEl.getBoundingClientRect();
        const viewportX = editorRect.left + local.left;
        const viewportY = editorRect.top + local.top;
        const MENU_WIDTH = 96; // single-button menu, ~80–96px
        const MENU_HEIGHT = 36;
        const x = Math.max(8, Math.min(viewportX, window.innerWidth - MENU_WIDTH - 8));
        const showAbove = viewportY >= MENU_HEIGHT + 8;
        const y = showAbove ? viewportY : viewportY + (local.height ?? 18) + 6;
        // Clamp inside editor's vertical bounds so the menu doesn't float above the
        // toolbar / below the editor when selection is partially scrolled out of view.
        if (y < editorRect.top - MENU_HEIGHT || y > editorRect.bottom + MENU_HEIGHT) return null;
        return { x, y, above: showAbove };
    }, []);

    /** Schedule a menu update on next animation frame. RAF coalesces the storm of
     *  selection-change events emitted during a mouse drag (Monaco fires per pixel) into
     *  a single position recompute, and naturally handles keyboard selection (shift+arrow)
     *  the same way without an extra mouseup hook. Bails early when the parent didn't opt
     *  into quoting so non-chat callers (settings panels etc.) pay zero per-selection cost. */
    const scheduleQuoteMenuUpdate = useCallback(() => {
        if (!onQuoteRef.current) return;
        if (quoteRafRef.current !== null) return;
        quoteRafRef.current = requestAnimationFrame(() => {
            quoteRafRef.current = null;
            const editor = editorRef.current;
            if (!editor || !onQuoteRef.current) {
                setQuoteMenu(null);
                return;
            }
            setQuoteMenu(computeQuoteMenuPosition(editor));
        });
    }, [computeQuoteMenuPosition]);

    /** Handle a click on the floating「引用」button: pull current selection from Monaco,
     *  trim leading/trailing blank-only lines (recompute startLine/endLine to match), drop
     *  trailing line when selection ends at column 1, then deliver to caller and clear. */
    const handleQuoteClick = useCallback(() => {
        const editor = editorRef.current;
        const onQuoteFn = onQuoteRef.current;
        if (!editor || !onQuoteFn) return;
        const sel = editor.getSelection();
        const model = editor.getModel();
        if (!sel || sel.isEmpty() || !model) return;

        // If user dragged to the start of next line, the included content stops at the
        // previous line — clamp endLine accordingly so emitted range matches what they see.
        let effEndLine = sel.endLineNumber;
        let effEndColumn = sel.endColumn;
        if (sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber) {
            effEndLine = sel.endLineNumber - 1;
            effEndColumn = model.getLineMaxColumn(effEndLine);
        }

        const text = model.getValueInRange({
            startLineNumber: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLineNumber: effEndLine,
            endColumn: effEndColumn,
        });

        // Trim head/tail blank-only lines & shift line range.
        const lines = text.split('\n');
        let headSkip = 0;
        while (headSkip < lines.length && lines[headSkip].trim() === '') headSkip++;
        let tailSkip = 0;
        while (tailSkip < lines.length - headSkip && lines[lines.length - 1 - tailSkip].trim() === '') tailSkip++;
        const trimmedText = lines.slice(headSkip, lines.length - tailSkip).join('\n');
        const startLine = sel.startLineNumber + headSkip;
        const endLine = effEndLine - tailSkip;

        if (!trimmedText.trim() || endLine < startLine) {
            // All blank — bail out without emitting; clear selection so the menu hides.
            editor.setSelection({ startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.startLineNumber, endColumn: sel.startColumn });
            return;
        }

        onQuoteFn({ text: trimmedText, startLine, endLine });
        // Clear selection so the menu auto-hides.
        editor.setSelection({ startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.startLineNumber, endColumn: sel.startColumn });
    }, []);

    // Force apply theme after mount to ensure it takes effect
    // This handles the case where beforeMount's defineTheme might not sync immediately
    // Also registers Cmd/Ctrl+S keybinding and handles autoFocus
    const handleOnMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor, monacoInstance: Monaco) => {
        monacoInstance.editor.setTheme(activeTheme);
        editorRef.current = editor;

        // Register Cmd/Ctrl+S keybinding
        editor.addCommand(
            monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
            () => { onSaveRef.current?.(); }
        );

        // Quote-menu wiring: register once. `onQuote` is read via ref so the listener
        // doesn't need re-registration when the callback identity changes upstream.
        const disposables: monaco.IDisposable[] = [];
        disposables.push(editor.onDidChangeCursorSelection(() => { scheduleQuoteMenuUpdate(); }));
        // Reposition menu while user scrolls the editor — selection stays put, but its
        // viewport coordinates move. Without this the menu would visually detach from the
        // selection during scroll.
        disposables.push(editor.onDidScrollChange(() => { scheduleQuoteMenuUpdate(); }));
        const editorDom = editor.getDomNode();
        if (editorDom) {
            const stayedInsideButton = (button: HTMLElement, relatedTarget: EventTarget | null) => {
                const relatedNode = relatedTarget instanceof Node ? relatedTarget : null;
                return !!relatedNode && button.contains(relatedNode);
            };
            const onMouseOver = (event: MouseEvent) => {
                const button = closestMonacoFindButton(event.target);
                if (!button || stayedInsideButton(button, event.relatedTarget)) return;
                scheduleFindTooltip(button);
            };
            const onMouseOut = (event: MouseEvent) => {
                const button = closestMonacoFindButton(event.target);
                if (!button || stayedInsideButton(button, event.relatedTarget)) return;
                hideFindTooltip();
            };
            const onFocusIn = (event: FocusEvent) => {
                const button = closestMonacoFindButton(event.target);
                if (button) showFindTooltipForButton(button);
            };
            const onFocusOut = (event: FocusEvent) => {
                const button = closestMonacoFindButton(event.target);
                if (!button || stayedInsideButton(button, event.relatedTarget)) return;
                hideFindTooltip();
            };
            const onPointerDown = (event: PointerEvent) => {
                if (closestMonacoFindButton(event.target)) hideFindTooltip();
            };

            editorDom.addEventListener('mouseover', onMouseOver);
            editorDom.addEventListener('mouseout', onMouseOut);
            editorDom.addEventListener('focusin', onFocusIn);
            editorDom.addEventListener('focusout', onFocusOut);
            editorDom.addEventListener('pointerdown', onPointerDown);
            window.addEventListener('resize', hideFindTooltip);
            disposables.push({
                dispose: () => {
                    editorDom.removeEventListener('mouseover', onMouseOver);
                    editorDom.removeEventListener('mouseout', onMouseOut);
                    editorDom.removeEventListener('focusin', onFocusIn);
                    editorDom.removeEventListener('focusout', onFocusOut);
                    editorDom.removeEventListener('pointerdown', onPointerDown);
                    window.removeEventListener('resize', hideFindTooltip);
                    clearFindTooltipTimer();
                    activeFindTooltipButtonRef.current = null;
                },
            });
        }
        // When the editor loses focus to a click outside (e.g. the menu button itself
        // intercepts mousedown to preserve selection), Monaco still keeps the selection.
        // No extra blur handling needed — selection-change covers clearing.
        editor.onDidDispose(() => {
            for (const d of disposables) d.dispose();
            clearFocusDecoration(editor);
            if (editorRef.current === editor) editorRef.current = null;
        });

        const mountFocusTarget =
            focusTarget ?? (initialLineNumber ? { requestId: -1, lineNumber: initialLineNumber } : undefined);
        if (mountFocusTarget) {
            // Give it a tiny delay to ensure layout is done
            clearPendingFocusTimer();
            focusMountTimerRef.current = window.setTimeout(() => {
                focusMountTimerRef.current = null;
                if (editorRef.current !== editor) return;
                // A newer navigation event arrived after mount. Do not let this
                // delayed initial focus pull the user back to an old result.
                if (focusTargetRef.current && focusTargetRef.current !== mountFocusTarget) return;
                if (!focusTarget && focusTargetRef.current) return;
                if (lastAppliedFocusTargetRef.current === mountFocusTarget) return;
                if (applyFocusTarget(mountFocusTarget)) {
                    lastAppliedFocusTargetRef.current = mountFocusTarget;
                }
            }, 50);
        }

        if (autoFocus) {
            // Use setTimeout to ensure editor is fully ready
            setTimeout(() => editor.focus(), 0);
        }
    }, [
        applyFocusTarget,
        autoFocus,
        activeTheme,
        clearFindTooltipTimer,
        clearFocusDecoration,
        clearPendingFocusTimer,
        focusTarget,
        hideFindTooltip,
        initialLineNumber,
        scheduleFindTooltip,
        scheduleQuoteMenuUpdate,
        showFindTooltipForButton,
    ]);

    useEffect(() => {
        if (!focusTarget || lastAppliedFocusTargetRef.current === focusTarget) return;
        clearPendingFocusTimer();
        if (applyFocusTarget(focusTarget)) {
            lastAppliedFocusTargetRef.current = focusTarget;
        }
    }, [applyFocusTarget, clearPendingFocusTimer, focusTarget]);

    // Cancel any pending RAF on unmount to avoid setState-after-unmount warning.
    useEffect(() => () => {
        if (quoteRafRef.current !== null) cancelAnimationFrame(quoteRafRef.current);
        clearFindTooltipTimer();
        clearPendingFocusTimer();
        clearFocusDecoration();
    }, [clearFindTooltipTimer, clearFocusDecoration, clearPendingFocusTimer]);

    // Defense for `onQuote` flipping defined → undefined mid-session: the JSX render-side
    // guard `{onQuote && quoteMenu && ...}` already hides the stale menu visually, and the
    // next `onDidChangeCursorSelection` (which fires the moment user touches the editor
    // again) overwrites `quoteMenu` with a fresh position when `onQuote` becomes defined
    // again. So no `useEffect`-based clear is needed — that would also trip the
    // `react-hooks/set-state-in-effect` rule by writing state from an effect.

    // Right-click context menu. Monaco's own menu is disabled (`contextmenu: false`
    // below) — it ships English labels and Monaco's own theme, and on macOS its
    // clipboard actions historically leaned on the native menu. We render the app's
    // shared <ContextMenu> instead (Chinese labels, design tokens) and drive the editor
    // through reliable APIs: model edits for cut/paste and the shared clipboard writer
    // (the menu click is a user gesture). This restores the
    // right-click fallback that was missing alongside the ⌘A fix.
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

    const copySelection = useCallback(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        const sel = editor?.getSelection();
        if (!editor || !model || !sel || sel.isEmpty()) return;
        void copyPlainText(model.getValueInRange(sel)).catch(() => {});
        editor.focus();
    }, []);

    const cutSelection = useCallback(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        const sel = editor?.getSelection();
        if (!editor || !model || !sel || sel.isEmpty()) return;
        const text = model.getValueInRange(sel);
        // Delete ONLY after the clipboard write succeeds — otherwise a denied
        // write would remove the text without copying it (silent data loss).
        // The captured `sel` range stays valid: nothing mutates the model in between.
        void copyPlainText(text).then(() => {
            editorRef.current?.executeEdits('ctx-cut', [{ range: sel, text: '' }]);
            editorRef.current?.focus();
        }).catch(() => {});
    }, []);

    const pasteClipboard = useCallback(() => {
        const editor = editorRef.current;
        const sel = editor?.getSelection();
        if (!editor || !sel) return;
        // readText() must run inside the click gesture; the edit afterwards is
        // programmatic. Use the range captured at invocation so a focus/selection
        // change while the read is pending can't redirect the paste elsewhere.
        void navigator.clipboard.readText().then((text) => {
            if (!text) return;
            editorRef.current?.executeEdits('ctx-paste', [{ range: sel, text }]);
            editorRef.current?.focus();
        }).catch(() => {});
    }, []);

    const selectAllText = useCallback(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!editor || !model) return;
        editor.setSelection(model.getFullModelRange());
        editor.focus();
    }, []);

    const openFind = useCallback(() => {
        const editor = editorRef.current;
        editor?.focus();
        editor?.getAction('actions.find')?.run();
    }, []);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        if (!editorRef.current) return;
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
    }, []);

    /** Built fresh each open so disabled states reflect the live selection. */
    const buildContextMenuItems = useCallback((): ContextMenuItem[] => {
        const sel = editorRef.current?.getSelection();
        const hasSelection = !!sel && !sel.isEmpty();
        const items: ContextMenuItem[] = [];
        if (!readOnly) {
            items.push({ label: t('monacoContext.cut'), icon: <Scissors className="h-4 w-4" />, disabled: !hasSelection, onClick: cutSelection });
        }
        items.push({ label: t('monacoContext.copy'), icon: <Copy className="h-4 w-4" />, disabled: !hasSelection, onClick: copySelection });
        if (!readOnly) {
            items.push({ label: t('monacoContext.paste'), icon: <ClipboardPaste className="h-4 w-4" />, onClick: pasteClipboard });
        }
        items.push({ separator: true });
        items.push({ label: t('monacoContext.selectAll'), icon: <TextSelect className="h-4 w-4" />, onClick: selectAllText });
        items.push({ separator: true });
        items.push({ label: t('monacoContext.find'), icon: <Search className="h-4 w-4" />, onClick: openFind });
        return items;
    }, [readOnly, cutSelection, copySelection, pasteClipboard, selectAllText, openFind, t]);

    // Monaco editor options optimized for performance
    const options = useMemo(() => ({
        readOnly,
        minimap: { enabled: false },
        lineNumbers: 'on' as const,
        scrollBeyondLastLine: false,
        wordWrap,
        wrappingStrategy: 'advanced' as const,
        // Disable accessibility support to fix CJK IME composition issues on WebKit/macOS.
        // When enabled, Monaco uses a different text measurement path that causes:
        // - Multi-line: entire line jumps right during pinyin composition
        // - Single-line: line bounces vertically during composition
        // See: https://github.com/microsoft/monaco-editor/issues/4270
        accessibilitySupport: 'off' as const,
        fontSize: monacoTheme.fontSize,
        lineHeight: monacoTheme.lineHeight,
        // Monaco cannot resolve host CSS variables reliably inside its canvas
        // measurement path, so the resolved Theme adapter supplies the stack.
        fontFamily: monacoTheme.fontFamily,
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 16, bottom: 16 },
        // Tighten the left gutter. `lineNumbersMinChars: 4` keeps room for up-to-9999-line
        // files without recomputing layout when the file grows; `lineDecorationsWidth: 2`
        // pulls content close to the line numbers (default 10 leaves a wasteful gap, especially
        // since `glyphMargin: false` already removed the breakpoint column).
        lineNumbersMinChars: 4,
        lineDecorationsWidth: 2,
        glyphMargin: false,
        scrollbar: {
            vertical: 'auto' as const,
            horizontal: 'auto' as const,
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
        },
        // Disable features for performance
        folding: true,
        foldingHighlight: false,
        showFoldingControls: 'mouseover' as const,
        renderWhitespace: 'none' as const,
        guides: {
            indentation: true,
            bracketPairs: false,
        },
        bracketPairColorization: { enabled: false },
        contextmenu: false,
        dragAndDrop: false,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        acceptSuggestionOnEnter: 'off' as const,
        hover: { enabled: false },
        parameterHints: { enabled: false },
        // Prevent long lines (e.g., minified JSON/JS) from freezing the tokenizer
        maxTokenizationLineLength: 10000,
        // Don't highlight every occurrence of the word under the cursor — feels like
        // a flicker storm on hover/click and adds no value when LSP is disabled anyway.
        // `selectionHighlight` (default true) is kept: explicitly selecting a word still
        // highlights its other occurrences, which is a useful cross-reference.
        occurrencesHighlight: 'off' as const,
        // Tame Monaco's "ambiguous Unicode" flagging for CJK content. The default boxes
        // every full-width punctuation mark (`，` `。` `；` etc.) because they look like
        // ASCII counterparts — useless noise for Chinese notes. We keep `invisibleCharacters`
        // on (catches zero-width sneak-ins) and turn off the comments/strings inclusions.
        unicodeHighlight: {
            ambiguousCharacters: false,
            invisibleCharacters: true,
            includeComments: false,
            includeStrings: false,
        },
        // Extend wordSeparators with CJK full-width punctuation so double-click in Chinese
        // text stops at `，` `。` etc. instead of swallowing whole paragraphs. Monaco's
        // default list only includes ASCII punctuation, which never appears mid-Chinese.
        wordSeparators: '~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?，。！？；：“”‘’「」『』（）【】《》、…—·',
    }), [monacoTheme.fontFamily, monacoTheme.fontSize, monacoTheme.lineHeight, readOnly, wordWrap]);

    // Wrapper class `monaco-editor-host` is targeted by index.css to add visual right
    // padding on the wrapper itself; Monaco's `automaticLayout: true` watches the
    // wrapper's content box via ResizeObserver and lays out the editor (and its overlay
    // scrollbar) within the reduced area. Monaco's own `padding` option only supports
    // top/bottom — wrapper padding is the supported workaround for horizontal padding.
    return (
        <div
            className={`monaco-editor-host relative h-full w-full overflow-hidden ${className}`}
            onContextMenu={handleContextMenu}
        >
            <Editor
                height="100%"
                language={language}
                value={value}
                onChange={handleChange}
                theme={activeTheme}
                options={options}
                beforeMount={handleBeforeMount}
                onMount={handleOnMount}
                loading={
                    <div className="flex h-full items-center justify-center gap-2 text-[var(--ink-muted)]">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span className="text-sm">{t('monacoEditor.loading')}</span>
                    </div>
                }
            />
            {/* Floating「引用」menu — only mounted when caller opted in via `onQuote`.
                Visual mirrors SelectionCommentMenu (`z-[300]`, same panel + button classes)
                so reading flow between assistant-message quote and file-selection quote
                stays identical. `retainFocusOnMouseDown` on both the panel and the button
                keeps Monaco's selection alive while the click registers — otherwise the
                editor steals focus on mousedown and clears the selection before
                `handleQuoteClick` can read `editor.getSelection()`. */}
            {onQuote && quoteMenu && (
                <div
                    className="fixed z-[300] flex items-center gap-0.5 rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-1 py-0.5 shadow-md"
                    style={{
                        left: quoteMenu.x,
                        top: quoteMenu.y,
                        transform: quoteMenu.above ? 'translateY(calc(-100% - 6px))' : undefined,
                    }}
                    onMouseDown={retainFocusOnMouseDown}
                >
                    <button
                        type="button"
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        onClick={handleQuoteClick}
                        onMouseDown={retainFocusOnMouseDown}
                    >
                        <Quote className="h-3 w-3" />
                        {t('monacoEditor.quote')}
                    </button>
                </div>
            )}
            {/* Portaled to <body> so the host's `overflow-hidden` (and any transformed
                modal ancestor) can never clip the floating menu — same reason
                FilePreviewModal portals itself. x/y are viewport coords, which is what
                <ContextMenu>'s fixed positioning + viewport clamping expect. */}
            {ctxMenu && createPortal(
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={buildContextMenuItems()}
                    onClose={() => setCtxMenu(null)}
                    // Above FilePreviewModal (z-[210]) and the quote menu (z-[300]) —
                    // the editor is most often mounted inside that modal, where the
                    // default z-50 would render the menu behind the backdrop.
                    zIndex={320}
                />,
                document.body,
            )}
            {findTooltip && createPortal(
                <div
                    className="myagents-monaco-find-tooltip"
                    style={{ left: findTooltip.x, top: findTooltip.top }}
                >
                    {findTooltip.label}
                </div>,
                document.body,
            )}
        </div>
    );
}
