/**
 * InlineCode - Styled inline code snippets
 *
 * When rendered inside a Chat (FileActionContext available), automatically
 * detects file/folder paths and makes them interactive. Primary click delegates
 * to FileActionContext; right-click opens the shared file menu.
 * Audio file paths get an inline play/stop button.
 */
import { useFileAction } from '@/context/FileActionContext';
import { isAudioPath } from '@/utils/audioPlayer';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { looksLikeFilePath } from '@/utils/pathDetection';
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
    const text = extractText(children);

    // Fast path: no context or not a path candidate → plain code
    if (!fileAction || !looksLikeFilePath(text)) {
        return <code className={BASE_CLASS}>{children}</code>;
    }

    // Normalize an in-workspace ABSOLUTE path to workspace-relative form before
    // the existence check + menu actions — the Rust resolver rejects absolute
    // paths, so without this an absolute path the model wrote in backticks
    // (e.g. `/Users/me/ws/CLAUDE.md`) silently stayed a plain <code>. Mirrors
    // the file-tool chip (tools/FilePath) so both surfaces resolve identically.
    // The chip still DISPLAYS the original text (`children`).
    const actionTarget = resolveFileActionTarget(text, fileAction.workspacePath);
    if (!actionTarget) {
        return <code className={BASE_CLASS}>{children}</code>;
    }

    // Ask context for cached result (may trigger a batched backend request)
    const pathInfo = fileAction.checkFileTarget(actionTarget);

    if (!pathInfo) {
        // Keep the first paint quiet while the batched existence check resolves.
        return <code className={BASE_CLASS}>{children}</code>;
    }

    // A recognized but unavailable target remains actionable: primary click
    // re-checks and explains the failure, while right-click preserves the
    // product menu (copy/reference/folder actions can still be useful).
    const isAudio = pathInfo.exists && isAudioPath(text);

    const handleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        fileAction.openFileTarget(actionTarget, {
            displayPath: text,
            forceExternal: e.metaKey || e.ctrlKey,
        });
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        fileAction.openFileMenu(e.clientX, e.clientY, actionTarget.path, pathInfo.type, text, {
            scope: actionTarget.scope,
        });
    };

    const codeEl = (
        <code
            className={INTERACTIVE_CLASS}
            onClick={handleClick}
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
