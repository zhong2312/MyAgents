/**
 * InlineCode - Styled inline code snippets
 *
 * When rendered inside a Chat (FileActionContext available), automatically
 * detects file/folder paths and makes them interactive. Primary click delegates
 * to FileActionContext; right-click opens the shared file menu.
 * Audio file paths get an inline play/stop button.
 */
import { useFileAction, useFileTargetInfo } from '@/context/FileActionContext';
import { useOpenWebLink } from '@/context/BrowserPanelContext';
import { isAudioPath } from '@/utils/audioPlayer';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { classifyInlineCodeTarget } from '@/utils/pathDetection';
import { resolveAgainstWorkspace, resolveFileActionTarget } from '@/utils/workspaceFileLinks';
import { Play, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface InlineCodeProps {
    children: React.ReactNode;
}

const BASE_CLASS = 'rounded bg-[var(--paper-inset)]/40 px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--ink)]';
const INTERACTIVE_CLASS = `${BASE_CLASS} border-b border-dashed border-[var(--ink-muted)] cursor-pointer hover:bg-[var(--accent-warm-subtle)] transition-colors`;

/** Extract plain text from React children (handles string / number / nested spans). */
function extractText(node: React.ReactNode): string {
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (node && typeof node === 'object' && 'props' in node) {
        return extractText((node as { props: { children?: React.ReactNode } }).props.children);
    }
    return '';
}

/** Inline play/pause button for audio file paths */
function AudioPlayButton({ filePath }: { filePath: string }) {
    const { t } = useTranslation('app');
    const { isPlaying, toggle } = useAudioPlayer(filePath);

    return (
        <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
            className="ml-1 inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] transition-colors hover:bg-[var(--accent-warm-hover)] align-middle"
            title={isPlaying ? t('inlineCode.pause') : t('inlineCode.playAudio')}
        >
            {isPlaying
                ? <Pause className="size-2.5 fill-current" />
                : <Play className="size-2.5 fill-current ml-px" />
            }
        </button>
    );
}

export default function InlineCode({ children }: InlineCodeProps) {
    const { t } = useTranslation('app');
    const fileAction = useFileAction(); // null outside Chat
    const openWebLink = useOpenWebLink();
    const text = extractText(children);
    const inlineTarget = classifyInlineCodeTarget(text);
    const actionTarget = fileAction && inlineTarget.kind === 'file'
        ? resolveFileActionTarget(inlineTarget.path, fileAction.workspacePath, { parseLineReference: true })
        : null;
    const pathInfo = useFileTargetInfo(actionTarget);

    if (inlineTarget.kind === 'web') {
        const handleWebClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
            e.preventDefault();
            const selection = window.getSelection();
            if (selection?.toString()) return;
            openWebLink(inlineTarget.url, { forceExternal: e.metaKey || e.ctrlKey });
        };

        return (
            <a
                href={inlineTarget.url}
                onClick={handleWebClick}
                className="inline text-inherit no-underline"
                style={{ userSelect: 'text' }}
            >
                <code className={INTERACTIVE_CLASS}>{children}</code>
            </a>
        );
    }

    // File links are a Chat-owned capability. Other surfaces keep inferred
    // paths as ordinary inline code even though web URLs remain normal links.
    if (!fileAction || inlineTarget.kind !== 'file') {
        return <code className={BASE_CLASS}>{children}</code>;
    }

    // Normalize an in-workspace ABSOLUTE path to workspace-relative form before
    // the existence check + menu actions — the Rust resolver rejects absolute
    // paths, so without this an absolute path the model wrote in backticks
    // (e.g. `/Users/me/ws/CLAUDE.md`) silently stayed a plain <code>. Mirrors
    // the file-tool chip (tools/FilePath) so both surfaces resolve identically.
    // The chip still DISPLAYS the original text (`children`).
    if (!actionTarget) {
        return <code className={BASE_CLASS}>{children}</code>;
    }

    if (!pathInfo?.exists) {
        // pending, missing, rejected and check failures are all ordinary code.
        // The dashed underline is a verified capability, not a path heuristic.
        return <code className={BASE_CLASS}>{children}</code>;
    }

    const isAudio = isAudioPath(inlineTarget.path);

    const openPrimary = (forceExternal: boolean) => {
        fileAction.openFileTarget(actionTarget, {
            displayPath: text,
            forceExternal,
        });
    };

    const handleClick = (e: React.MouseEvent) => {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        e.stopPropagation();
        openPrimary(e.metaKey || e.ctrlKey);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        openPrimary(e.metaKey || e.ctrlKey);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        fileAction.openFileTargetMenu(e.clientX, e.clientY, actionTarget, {
            displayPath: text,
        });
    };

    const codeEl = (
        <code
            className={INTERACTIVE_CLASS}
            role="link"
            tabIndex={0}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            onContextMenu={handleContextMenu}
            title={pathInfo.type === 'dir'
                ? t('inlineCode.folderTitle', { path: text })
                : t('inlineCode.fileTitle', { path: text })}
        >
            {children}
        </code>
    );

    // Only wrap in span when audio button is needed, preserving DOM structure for non-audio paths
    if (isAudio) {
        // The audio player ultimately calls cmd_read_file_base64, which REQUIRES
        // an absolute path ("Path must be absolute" otherwise). The model writes
        // workspace-relative paths (e.g. myagents_files/generated_audio/x.mp3),
        // so resolve against the workspace root before playback — otherwise the
        // button silently no-ops (the original bug). Fallback to the raw text only
        // when there's no workspace (then it was likely already absolute).
        const audioPath = resolveAgainstWorkspace(text, fileAction.workspacePath) ?? text;
        return (
            <span className="inline-flex items-center">
                {codeEl}
                <AudioPlayButton filePath={audioPath} />
            </span>
        );
    }

    return codeEl;
}
